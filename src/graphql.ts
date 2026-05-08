import type { OperationConfig } from './types.js'

export class Operation<TVariables extends object, TData> {
  readonly config: OperationConfig
  // phantom fields — never assigned; exist only so TypeScript can infer TVariables/TData
  // from conditional types in createGraphQL (e.g. `T extends Operation<infer V, infer D>`)
  declare readonly _variables: TVariables
  declare readonly _data: TData
  constructor(config: OperationConfig) {
    this.config = config
  }
}

export const gql = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  String.raw({ raw: strings }, ...values)
