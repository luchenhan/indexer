import {
  BigNumber,
  BigNumberish,
  ContractReceipt,
  ContractTransaction,
  providers,
  utils,
  Wallet,
} from 'ethers'
import {
  Address,
  Eventual,
  Logger,
  mutable,
  NetworkContracts,
  toAddress,
} from '@graphprotocol/common-ts'
import delay from 'delay'
import { TransactionMonitoring } from './network-specification'
import { IndexerError, indexerError, IndexerErrorCode } from './errors'
import { TransactionConfig, TransactionType } from './types'
import { NetworkSubgraph } from './network-subgraph'
import gql from 'graphql-tag'
import { sequentialTimerReduce } from './sequential-timer'

export class TransactionManager {
  ethereum: providers.BaseProvider
  wallet: Wallet
  paused: Eventual<boolean>
  isOperator: Eventual<boolean>
  specification: TransactionMonitoring
  adjustedGasIncreaseFactor: BigNumber
  adjustedBaseFeePerGasMax: number

  constructor(
    ethereum: providers.BaseProvider,
    wallet: Wallet,
    paused: Eventual<boolean>,
    isOperator: Eventual<boolean>,
    specification: TransactionMonitoring,
  ) {
    this.ethereum = ethereum
    this.wallet = wallet
    this.paused = paused
    this.isOperator = isOperator
    this.specification = specification
    this.adjustedGasIncreaseFactor = utils.parseUnits(
      specification.gasIncreaseFactor.toString(),
      3,
    )
    this.adjustedBaseFeePerGasMax =
      specification.baseFeePerGasMax || specification.gasPriceMax
  }

  async executeTransaction(
    gasEstimation: () => Promise<BigNumber>,
    transaction: (gasLimit: BigNumberish) => Promise<ContractTransaction>,
    logger: Logger,
  ): Promise<ContractReceipt | 'paused' | 'unauthorized'> {
    if (await this.paused.value()) {
      logger.info(`Network is paused, skipping this action`)
      return 'paused'
    }

    if (!(await this.isOperator.value())) {
      logger.info(`Not authorized as an operator for indexer, skipping this action`)
      return 'unauthorized'
    }

    let pending = true
    let output: providers.TransactionReceipt | undefined = undefined

    const feeData = await this.waitForGasPricesBelowThreshold(logger)
    const paddedGasLimit = Math.ceil((await gasEstimation()).toNumber() * 1.5)

    const txPromise = transaction(paddedGasLimit)
    let tx = await txPromise
    let txRequest: providers.TransactionRequest | undefined = undefined

    let txConfig: TransactionConfig = {
      attempt: 1,
      type: await this.transactionType(feeData),
      gasBump: this.adjustedGasIncreaseFactor,
      nonce: tx.nonce,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      gasPrice: tx.gasPrice,
      gasLimit: tx.gasLimit,
    }

    logger.info(`Sending transaction`, { txConfig })

    while (pending) {
      if (
        this.specification.maxTransactionAttempts !== 0 &&
        txConfig.attempt > this.specification.maxTransactionAttempts
      ) {
        logger.warn('Transaction retry limit reached, giving up', {
          txConfig,
        })
        await delay(30000)
        break
      }

      try {
        if (txConfig.attempt > 1) {
          logger.info('Resubmitting transaction', {
            txConfig,
          })
          txRequest = {
            value: tx.value,
            to: tx.to,
            data: tx.data,
            chainId: tx.chainId,
            from: tx.from,
            nonce: txConfig.nonce,
            gasPrice: txConfig.gasPrice,
            maxPriorityFeePerGas: txConfig.maxPriorityFeePerGas,
            maxFeePerGas: txConfig.maxFeePerGas,
            gasLimit: txConfig.gasLimit,
          }
          tx = await this.wallet.sendTransaction(txRequest)
        }

        logger.info(`Transaction pending`, { tx: tx })

        const receipt = await this.ethereum.waitForTransaction(
          tx.hash,
          3,
          this.specification.gasIncreaseTimeout,
        )

        if (receipt.status == 0) {
          const revertReason = await this.getRevertReason(
            logger,
            txRequest as providers.TransactionRequest,
          )
          if (revertReason === 'out of gas') {
            throw indexerError(IndexerErrorCode.IE050)
          } else if (revertReason === 'unknown') {
            throw indexerError(IndexerErrorCode.IE051)
          } else {
            throw indexerError(IndexerErrorCode.IE057)
          }
        }

        logger.info(`Transaction successfully included in block`, {
          tx: tx.hash,
          receipt: receipt,
        })
        output = receipt
        pending = false
      } catch (error) {
        txConfig = await this.updateTransactionConfig(logger, txConfig, error)
        continue
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return output!
  }

  async getRevertReason(
    logger: Logger,
    txRequest: providers.TransactionRequest,
  ): Promise<string> {
    let revertReason = 'unknown'
    try {
      const code = await this.ethereum.call(txRequest)
      revertReason = utils.toUtf8String(`0x${code.substr(138)}`)
    } catch (e) {
      if (e.body.includes('out of gas')) {
        revertReason = 'out of gas'
      } else {
        throw indexerError(IndexerErrorCode.IE051)
      }
    }
    logger.warn('Transaction reverted:', { reason: revertReason })
    return revertReason
  }

  async updateTransactionConfig(
    logger: Logger,
    txConfig: TransactionConfig,
    error: Error | IndexerError,
  ): Promise<TransactionConfig> {
    logger.warning('Failed to send transaction, evaluating retry possibilities', {
      error: error.message,
    })
    if (error instanceof IndexerError) {
      if (error.code == IndexerErrorCode.IE050) {
        txConfig.gasLimit = BigNumber.from(txConfig.gasLimit)
          .mul(txConfig.gasBump)
          .div(1000)
        txConfig.nonce = BigNumber.from(txConfig.nonce).add(1)
      } else if (error.code == IndexerErrorCode.IE051) {
        throw error
      }
    } else if (error instanceof Error) {
      if (
        error.message.includes('Transaction with the same hash was already imported') ||
        error.message.includes('nonce has already been used')
      ) {
        // This case typically indicates a successful transaction being retried.
        // Let's introduce a 30 second delay to ensure the previous transaction has
        // a chance to be mined and return to the reconciliation loop so the agent can reevaluate.
        await delay(30000)
        throw indexerError(
          IndexerErrorCode.IE058,
          `Original transaction was not confirmed though it may have been successful`,
        )
      } else if (
        error.message.includes(
          'Transaction nonce is too low. Try incrementing the nonce.',
        )
      ) {
        txConfig.nonce = BigNumber.from(txConfig.nonce).add(1)
      } else if (
        error.message.includes('Try increasing the fee') ||
        error.message.includes('gas price supplied is too low') ||
        error.message?.includes('timeout exceeded')
      ) {
        // Transaction timed out or failed due to a low gas price estimation, bump gas price and retry
        if (txConfig.type === TransactionType.ZERO) {
          txConfig.gasPrice = BigNumber.from(txConfig.gasPrice)
            .mul(txConfig.gasBump)
            .div(1000)
        } else if (txConfig.type == TransactionType.TWO) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          txConfig.maxFeePerGas = BigNumber.from(txConfig.maxFeePerGas)
            .mul(txConfig.gasBump)
            .div(1000)
          txConfig.maxPriorityFeePerGas = BigNumber.from(txConfig.maxPriorityFeePerGas)
            .mul(txConfig.gasBump)
            .div(1000)
        }
      }
    }
    txConfig.attempt += 1
    return txConfig
  }
  async transactionType(data: providers.FeeData): Promise<TransactionType> {
    if (data.maxPriorityFeePerGas && data.maxFeePerGas) {
      return TransactionType.TWO
    } else if (data.gasPrice) {
      return TransactionType.ZERO
    } else {
      throw new Error(
        `Network fee data failed validation: gasPrice: ${data.gasPrice}, maxPriorityFeePerGas: ${data.maxPriorityFeePerGas}, maxFeePerGass: ${data.maxFeePerGas}`,
      )
    }
  }
  async waitForGasPricesBelowThreshold(logger: Logger): Promise<providers.FeeData> {
    let attempt = 1
    let aboveThreshold = true
    let feeData = {
      gasPrice: null,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    } as providers.FeeData

    while (aboveThreshold) {
      feeData = await this.ethereum.getFeeData()
      const type = await this.transactionType(feeData)
      if (type === TransactionType.TWO) {
        // Type 0x02 transaction
        // This baseFeePerGas calculation is based off how maxFeePerGas is calculated in getFeeData()
        // https://github.com/ethers-io/ethers.js/blob/68229ac0aff790b083717dc73cd84f38d32a3926/packages/abstract-provider/src.ts/index.ts#L247
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const baseFeePerGas = feeData
          .maxFeePerGas! // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          .sub(feeData.maxPriorityFeePerGas!)
          .div(2)
        if (baseFeePerGas.toNumber() >= this.adjustedBaseFeePerGasMax) {
          if (attempt === 1) {
            logger.warning(
              `Max base fee per gas has been reached, waiting until the base fee falls below to resume transaction execution.`,
              { maxBaseFeePerGas: this.specification.baseFeePerGasMax, baseFeePerGas },
            )
          } else {
            logger.info(`Base gas fee per gas estimation still above max threshold`, {
              maxBaseFeePerGas: this.specification.baseFeePerGasMax,
              baseFeePerGas: baseFeePerGas.toNumber(),
              priceEstimateAttempt: attempt,
            })
          }
          await delay(30000)
          attempt++
        } else {
          aboveThreshold = false
          feeData.gasPrice = null
        }
      } else if (type === TransactionType.ZERO) {
        // Legacy transaction type
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (feeData.gasPrice!.toNumber() >= this.adjustedBaseFeePerGasMax) {
          if (attempt === 1) {
            logger.warning(
              `Max gas price has been reached, waiting until gas price estimates fall below to resume transaction execution.`,
              {
                baseFeePerGasMax: this.specification.baseFeePerGasMax,
                currentGasPriceEstimate: feeData.gasPrice!.toNumber(),
              },
            )
          } else {
            logger.info(`Gas price estimation still above max threshold`, {
              baseFeePerGasMax: this.specification.baseFeePerGasMax,
              currentGasPriceEstimate: feeData.gasPrice!.toNumber(),
              priceEstimateAttempt: attempt,
            })
          }
          await delay(30000)
          attempt++
        } else {
          aboveThreshold = false
        }
      }
    }
    return feeData
  }

  async monitorNetworkPauses(
    logger: Logger,
    contracts: NetworkContracts,
    networkSubgraph: NetworkSubgraph,
  ): Promise<Eventual<boolean>> {
    return sequentialTimerReduce(
      {
        logger,
        milliseconds: 60_000,
      },
      async (currentlyPaused) => {
        try {
          const result = await networkSubgraph.checkedQuery(gql`
            {
              graphNetworks {
                isPaused
              }
            }
          `)

          if (result.error) {
            throw result.error
          }

          if (!result.data || result.data.length === 0) {
            throw new Error(`No data returned by network subgraph`)
          }

          return result.data.graphNetworks[0].isPaused
        } catch (err) {
          logger.warn(`Failed to check for network pause, assuming it has not changed`, {
            err: indexerError(IndexerErrorCode.IE007, err),
            paused: currentlyPaused,
          })
          return currentlyPaused
        }
      },
      await contracts.controller.paused(),
    ).map((paused) => {
      logger.info(paused ? `Network paused` : `Network active`)
      return paused
    })
  }

  async monitorIsOperator(
    logger: Logger,
    contracts: NetworkContracts,
    indexerAddress: Address,
    wallet: Wallet,
  ): Promise<Eventual<boolean>> {
    // If indexer and operator address are identical, operator status is
    // implicitly granted => we'll never have to check again
    if (indexerAddress === toAddress(wallet.address)) {
      logger.info(`Indexer and operator are identical, operator status granted`)
      return mutable(true)
    }

    return sequentialTimerReduce(
      {
        logger,
        milliseconds: 60_000,
      },
      async (isOperator) => {
        try {
          return await contracts.staking.isOperator(wallet.address, indexerAddress)
        } catch (err) {
          logger.warn(
            `Failed to check operator status for indexer, assuming it has not changed`,
            { err: indexerError(IndexerErrorCode.IE008, err), isOperator },
          )
          return isOperator
        }
      },
      await contracts.staking.isOperator(wallet.address, indexerAddress),
    ).map((isOperator) => {
      logger.info(
        isOperator
          ? `Have operator status for indexer`
          : `No operator status for indexer`,
      )
      return isOperator
    })
  }

  findEvent(
    eventType: string,
    contractInterface: utils.Interface,
    logKey: string,
    logValue: string,
    receipt: ContractReceipt,
    logger: Logger,
  ): utils.Result | undefined {
    const events: Event[] | providers.Log[] = receipt.events || receipt.logs
    const decodedEvents: utils.Result[] = []
    const expectedTopic = contractInterface.getEventTopic(eventType)

    const result = events
      .filter((event) => event.topics.includes(expectedTopic))
      .map((event) => {
        const decoded = contractInterface.decodeEventLog(
          eventType,
          event.data,
          event.topics,
        )
        decodedEvents.push(decoded)
        return decoded
      })
      .find(
        (eventLogs) =>
          eventLogs[logKey].toLocaleLowerCase() === logValue.toLocaleLowerCase(),
      )

    logger.trace('Searched for event logs', {
      function: 'findEvent',
      expectedTopic,
      events,
      decodedEvents,
      eventType,
      logKey,
      logValue,
      receipt,
      found: !!result,
      result,
    })

    return result
  }
}
