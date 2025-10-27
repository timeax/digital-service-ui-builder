/** Minimal capability shape sourced from DgpService */
export type DgpServiceCapability = {
    id: number;
    name?: string;                    // human-friendly name
    key?: string;                     // provider key if relevant
    rate?: number;                    // canonical numeric rate
    min?: number;                     // min order qty
    max?: number;                     // max order qty
    dripfeed?: boolean;
    refill?: boolean;
    cancel?: boolean;
    estimate?: { start?: number | null; speed?: number | null; average?: number | null };
    meta?: Record<string, unknown>;
    [x: string]: any;
};

export type DgpServiceMap = Record<number, DgpServiceCapability>; // id -> capability