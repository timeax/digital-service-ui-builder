import React, { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { createInputRegistry } from "./registry";
import type {
    Registry,
    InputDescriptor,
    InputKind,
    InputVariant,
} from "./registry";

type InputsCtxValue = {
    registry: Registry;
    register: (
        kind: InputKind,
        descriptor: InputDescriptor,
        variant?: InputVariant,
    ) => void;
    unregister: (kind: InputKind, variant?: InputVariant) => void;
    registerMany: (
        entries: Array<{
            kind: InputKind;
            descriptor: InputDescriptor;
            variant?: InputVariant;
        }>,
    ) => void;
};

const Ctx = createContext<InputsCtxValue | null>(null);

export function Provider({
    children,
    initialRegistry,
}: {
    children: ReactNode;
    /** Optional pre-built registry (e.g., you registered built-ins/customs before mounting) */
    initialRegistry?: Registry;
}) {
    const registry = useMemo(
        () => initialRegistry ?? createInputRegistry(),
        [initialRegistry],
    );

    const value = useMemo<InputsCtxValue>(
        () => ({
            registry,
            register: registry.register,
            unregister: registry.unregister,
            registerMany: registry.registerMany,
        }),
        [registry],
    );

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useInputs(): InputsCtxValue {
    const v = useContext(Ctx);
    if (!v) throw new Error("useInputs() must be used within <InputsProvider>");
    return v;
}
