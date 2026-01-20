import type React from 'react';
import type {Scalar} from '../../schema/order';

/** Matches your InputWrapper’s expectations */
export type InputKind = string;               // e.g. "text", "number", "select", "custom:Rating"
export type InputVariant = 'default' | (string & {});

export type InputAdapter = {
    /** Prop name where the value goes on the host component (default: "value") */
    valueProp?: string;
    /** Prop name of the change handler on the host component (default: "onChange") */
    changeProp?: string;
    /**
     * Normalize the host's change payload into a Scalar | Scalar[] your form will store.
     * If omitted, `next as Scalar | Scalar[]` is used.
     */
    getValue?: (next: unknown, prev: unknown) => Scalar | Scalar[];
};

export type InputDescriptor = {
    Component: React.ComponentType<Record<string, unknown>>;
    adapter?: InputAdapter;
    defaultProps?: Record<string, unknown>;
};

type VariantMap = Map<InputVariant, InputDescriptor>;
type RegistryStore = Map<InputKind, VariantMap>;

export type Registry = {
    get(kind: InputKind, variant?: InputVariant): InputDescriptor | undefined;
    register(kind: InputKind, descriptor: InputDescriptor, variant?: InputVariant): void;
    unregister(kind: InputKind, variant?: InputVariant): void;
    registerMany(entries: Array<{ kind: InputKind; descriptor: InputDescriptor; variant?: InputVariant }>): void;
    /** low-level escape hatch */
    _store: RegistryStore;
};

export function createInputRegistry(): Registry {
    const store: RegistryStore = new Map();

    const get = (kind: InputKind, variant?: InputVariant): InputDescriptor | undefined => {
        const vm = store.get(kind);
        if (!vm) return undefined;
        const v = (variant ?? 'default') as InputVariant;
        return vm.get(v) ?? vm.get('default');
    };

    const register = (kind: InputKind, descriptor: InputDescriptor, variant?: InputVariant): void => {
        let vm = store.get(kind);
        if (!vm) {
            vm = new Map<InputVariant, InputDescriptor>();
            store.set(kind, vm);
        }
        vm.set((variant ?? 'default') as InputVariant, descriptor);
    };

    const unregister = (kind: InputKind, variant?: InputVariant): void => {
        const vm = store.get(kind);
        if (!vm) return;
        const key = (variant ?? 'default') as InputVariant;
        vm.delete(key);
        if (vm.size === 0) store.delete(kind);
    };

    const registerMany = (entries: Array<{ kind: InputKind; descriptor: InputDescriptor; variant?: InputVariant }>): void => {
        for (const e of entries) register(e.kind, e.descriptor, e.variant);
    };

    return { get, register, unregister, registerMany, _store: store };
}

/** Helper used by InputWrapper */
export function resolveInputDescriptor(
    registry: Registry,
    kind: InputKind,
    variant?: InputVariant
): InputDescriptor | undefined {
    return registry.get(kind, variant);
}