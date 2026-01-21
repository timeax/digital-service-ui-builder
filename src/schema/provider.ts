// src/schema/provider.ts
export type TimeRangeEstimate = {
    min_seconds?: number;
    max_seconds?: number;
    label?: string; // "instant" | "5-30 mins" | ...
    meta?: Record<string, unknown>;
};

export type SpeedEstimate = {
    amount?: number; // e.g. 500
    per?: "minute" | "hour" | "day" | "week" | "month";
    unit?: string; // e.g. "followers", "likes"
    label?: string; // e.g. "500/day", "fast"
    meta?: Record<string, unknown>;
};

export type ServiceEstimates = {
    start?: TimeRangeEstimate;
    speed?: SpeedEstimate;
    average?: TimeRangeEstimate;
    meta?: Record<string, unknown>;
};

export type ServiceFlag = {
    enabled: boolean;
    description: string; // MUST
    meta?: Record<string, unknown>;
};

export type IdType = string | number;

export type ServiceFlags = Record<string, ServiceFlag>; // flagId -> flag

export type DgpServiceCapability = {
    id: IdType;
    name: string;
    rate: number;
    min?: number;
    max?: number;

    category?: string;

    flags?: ServiceFlags;
    estimates?: ServiceEstimates;

    meta?: Record<string, unknown>;
    [x: string]: any;
};

export type DgpServiceMap = Record<string, DgpServiceCapability> &
    Record<number, DgpServiceCapability>;
