import type { OperationConfig } from './types.js'

export class Operation<TVariables extends object, TData> {
  readonly config: OperationConfig
  constructor(config: OperationConfig) {
    this.config = config
  }
}

export const gql = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  String.raw({ raw: strings }, ...values)
