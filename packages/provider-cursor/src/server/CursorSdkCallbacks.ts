import type {
  AgentOptions,
  LocalAgentStore,
  LocalSubagentInherit,
  LocalSubagentResourceProviderFields,
  SDKCustomTool,
  SendOptions,
} from "@cursor/sdk";

type WireTools = Record<string, Omit<SDKCustomTool, "execute"> & { readonly execute: number }>;
type WireResourceFields = {
  readonly [
    K in keyof LocalSubagentResourceProviderFields
  ]: LocalSubagentResourceProviderFields[K] extends boolean | undefined ? boolean : number;
};
type WireInherit = Omit<LocalSubagentInherit, "resourceProviderOptions"> & {
  readonly resourceProviderOptions?: WireResourceFields | { readonly factory: number };
};
type WireStore = {
  readonly [Group in keyof LocalAgentStore]: {
    readonly [Method in keyof LocalAgentStore[Group]]: number;
  };
};
type WireLocal = Omit<
  NonNullable<AgentOptions["local"]>,
  "customTools" | "store" | "subagentInherit"
> & {
  readonly customTools?: WireTools;
  readonly store?: WireStore;
  readonly subagentInherit?: WireInherit;
};
export type CursorSdkWireAgentOptions = Omit<AgentOptions, "local"> & {
  readonly local?: WireLocal;
};
export type CursorSdkWireSendOptions = Omit<SendOptions, "onDelta" | "onStep" | "local"> & {
  readonly onStep?: number;
  readonly local?: Omit<NonNullable<SendOptions["local"]>, "customTools" | "subagentInherit"> & {
    readonly customTools?: WireTools;
    readonly subagentInherit?: WireInherit;
  };
};

const EXECUTORS = [
  "overrideReadExecutor",
  "overrideWriteExecutor",
  "overrideGrepExecutor",
  "overrideLsExecutor",
  "overrideShellExecutor",
] as const;
const STORE_METHODS = {
  agents: ["get", "create", "update", "delete", "list"],
  checkpoints: ["get", "create", "update", "delete", "list"],
  runs: ["get", "create", "update", "delete", "list"],
  runEvents: ["append", "list", "delete"],
} as const;

export interface CursorSdkCallbackScope {
  readonly agentOptions: (options: AgentOptions) => CursorSdkWireAgentOptions;
  readonly sendOptions: (options: Omit<SendOptions, "onDelta">) => CursorSdkWireSendOptions;
  readonly close: () => void;
}

export class CursorSdkCallbacks {
  private nextKey = 0;
  private readonly callbacks = new Map<number, (input: unknown) => unknown>();

  invoke(key: number, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const callback = this.callbacks.get(key);
    if (callback === undefined)
      return Promise.reject(new Error("Cursor SDK callback belongs to a closed run or session."));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      void Promise.resolve()
        .then(() => {
          if (signal?.aborted) throw signal.reason;
          return callback(input);
        })
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener("abort", abort));
    });
  }

  scope(): CursorSdkCallbackScope {
    const keys = new Set<number>();
    let closed = false;
    const register = <Input, Output>(callback: (input: Input) => Output): number => {
      if (closed) throw new Error("Cursor SDK callback scope is closed.");
      if (this.callbacks.size >= 256) throw new Error("Cursor SDK exceeded the callback limit.");
      const key = ++this.nextKey;
      keys.add(key);
      this.callbacks.set(key, (input) => callback(input as Input));
      return key;
    };
    const tools = (value: Record<string, SDKCustomTool>): WireTools =>
      Object.fromEntries(
        Object.entries(value).map(([name, tool]) => [
          name,
          {
            ...tool,
            execute: register((input: Parameters<SDKCustomTool["execute"]>) =>
              tool.execute(...input),
            ),
          },
        ]),
      );
    const resourceFields = (value: LocalSubagentResourceProviderFields): WireResourceFields => {
      const result: { -readonly [K in keyof WireResourceFields]: WireResourceFields[K] } = {};
      if (value.suppressDefaultShellExecutor !== undefined)
        result.suppressDefaultShellExecutor = value.suppressDefaultShellExecutor;
      for (const key of EXECUTORS) {
        const executor = value[key];
        if (executor !== undefined) {
          result[key] = register((args: never[]) => executor.execute(...args));
        }
      }
      return result;
    };
    const inherit = (value: LocalSubagentInherit): WireInherit => {
      const { resourceProviderOptions, ...rest } = value;
      return {
        ...rest,
        ...(resourceProviderOptions === undefined
          ? {}
          : {
              resourceProviderOptions:
                typeof resourceProviderOptions === "function"
                  ? {
                      factory: register(
                        async (context: Parameters<typeof resourceProviderOptions>[0]) =>
                          resourceFields(await resourceProviderOptions(context)),
                      ),
                    }
                  : resourceFields(resourceProviderOptions),
            }),
      };
    };
    const store = (value: LocalAgentStore): WireStore => {
      const part = <Group extends keyof LocalAgentStore>(group: Group): WireStore[Group] =>
        Object.fromEntries(
          STORE_METHODS[group].map((method) => [
            method,
            register((input: unknown) => {
              const target = value[group];
              const operation = Reflect.get(target, method) as (input: unknown) => Promise<unknown>;
              return operation.call(target, input);
            }),
          ]),
        ) as WireStore[Group];
      return {
        agents: part("agents"),
        checkpoints: part("checkpoints"),
        runs: part("runs"),
        runEvents: part("runEvents"),
      };
    };
    return {
      agentOptions: ({ local, ...options }) => ({
        ...options,
        ...(local === undefined
          ? {}
          : {
              local: (() => {
                const { customTools, subagentInherit, store: localStore, ...rest } = local;
                return {
                  ...rest,
                  ...(customTools === undefined ? {} : { customTools: tools(customTools) }),
                  ...(subagentInherit === undefined
                    ? {}
                    : { subagentInherit: inherit(subagentInherit) }),
                  ...(localStore === undefined ? {} : { store: store(localStore) }),
                };
              })(),
            }),
      }),
      sendOptions: ({ onStep, local, ...options }) => ({
        ...options,
        ...(onStep === undefined
          ? {}
          : { onStep: register((input: Parameters<typeof onStep>[0]) => onStep(input)) }),
        ...(local === undefined
          ? {}
          : {
              local: (() => {
                const { customTools, subagentInherit, ...rest } = local;
                return {
                  ...rest,
                  ...(customTools === undefined ? {} : { customTools: tools(customTools) }),
                  ...(subagentInherit === undefined
                    ? {}
                    : { subagentInherit: inherit(subagentInherit) }),
                };
              })(),
            }),
      }),
      close: () => {
        closed = true;
        for (const key of keys) this.callbacks.delete(key);
        keys.clear();
      },
    };
  }
}

export function cursorSdkWorkerOptions(call: (key: number, input: unknown) => Promise<unknown>) {
  const tools = (value: WireTools): Record<string, SDKCustomTool> =>
    Object.fromEntries(
      Object.entries(value).map(([name, tool]) => [
        name,
        {
          ...tool,
          execute: (...input: Parameters<SDKCustomTool["execute"]>) =>
            call(tool.execute, input) as ReturnType<SDKCustomTool["execute"]>,
        },
      ]),
    );
  const resourceFields = (value: WireResourceFields): LocalSubagentResourceProviderFields => {
    const result: {
      -readonly [
        K in keyof LocalSubagentResourceProviderFields
      ]: LocalSubagentResourceProviderFields[K];
    } = {};
    if (value.suppressDefaultShellExecutor !== undefined)
      result.suppressDefaultShellExecutor = value.suppressDefaultShellExecutor;
    for (const key of EXECUTORS) {
      const reference = value[key];
      if (reference !== undefined)
        result[key] = { execute: (...args: never[]) => call(reference, args) };
    }
    return result;
  };
  const inherit = (value: WireInherit): LocalSubagentInherit => {
    const { resourceProviderOptions, ...rest } = value;
    return {
      ...rest,
      ...(resourceProviderOptions === undefined
        ? {}
        : {
            resourceProviderOptions:
              "factory" in resourceProviderOptions
                ? async (context) =>
                    resourceFields(
                      (await call(resourceProviderOptions.factory, context)) as WireResourceFields,
                    )
                : resourceFields(resourceProviderOptions),
          }),
    };
  };
  const store = (value: WireStore): LocalAgentStore => {
    const invoke = <Output>(reference: number, input: unknown): Promise<Output> =>
      call(reference, input) as Promise<Output>;
    return {
      agents: {
        get: (input) => invoke(value.agents.get, input),
        create: (input) => invoke(value.agents.create, input),
        update: (input) => invoke(value.agents.update, input),
        delete: (input) => invoke(value.agents.delete, input),
        list: (input) => invoke(value.agents.list, input),
      },
      checkpoints: {
        get: (input) => invoke(value.checkpoints.get, input),
        create: (input) => invoke(value.checkpoints.create, input),
        update: (input) => invoke(value.checkpoints.update, input),
        delete: (input) => invoke(value.checkpoints.delete, input),
        list: (input) => invoke(value.checkpoints.list, input),
      },
      runs: {
        get: (input) => invoke(value.runs.get, input),
        create: (input) => invoke(value.runs.create, input),
        update: (input) => invoke(value.runs.update, input),
        delete: (input) => invoke(value.runs.delete, input),
        list: (input) => invoke(value.runs.list, input),
      },
      runEvents: {
        append: (input) => invoke(value.runEvents.append, input),
        list: (input) => invoke(value.runEvents.list, input),
        delete: (input) => invoke(value.runEvents.delete, input),
      },
    };
  };
  return {
    agentOptions: ({ local, ...options }: CursorSdkWireAgentOptions): AgentOptions => ({
      ...options,
      ...(local === undefined
        ? {}
        : {
            local: (() => {
              const { customTools, subagentInherit, store: localStore, ...rest } = local;
              return {
                ...rest,
                ...(customTools === undefined ? {} : { customTools: tools(customTools) }),
                ...(subagentInherit === undefined
                  ? {}
                  : { subagentInherit: inherit(subagentInherit) }),
                ...(localStore === undefined ? {} : { store: store(localStore) }),
              };
            })(),
          }),
    }),
    sendOptions: ({
      local,
      onStep,
      ...options
    }: CursorSdkWireSendOptions): Omit<SendOptions, "onDelta"> => ({
      ...options,
      ...(onStep === undefined
        ? {}
        : {
            onStep: async (input) => {
              await call(onStep, input);
            },
          }),
      ...(local === undefined
        ? {}
        : {
            local: (() => {
              const { customTools, subagentInherit, ...rest } = local;
              return {
                ...rest,
                ...(customTools === undefined ? {} : { customTools: tools(customTools) }),
                ...(subagentInherit === undefined
                  ? {}
                  : { subagentInherit: inherit(subagentInherit) }),
              };
            })(),
          }),
    }),
  };
}
