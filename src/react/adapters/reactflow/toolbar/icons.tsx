import React from 'react';

export const Icons = {
    bind: (active = false) => (
        <svg className={`h-4 w-4 ${active ? 'text-primary' : 'text-muted-foreground'}`} viewBox="0 0 20 20" fill="none">
            <path d="M6 8a4 4 0 014-4h2a4 4 0 110 8H9" stroke="currentColor" strokeWidth="2"/>
            <path d="M14 12a4 4 0 01-4 4H8a4 4 0 110-8h3" stroke="currentColor" strokeWidth="2"/>
        </svg>
    ),
    include: (active = false) => (
        <svg className={`h-4 w-4 ${active ? 'text-primary' : 'text-muted-foreground'}`} viewBox="0 0 20 20" fill="none">
            <path d="M8 10h8M8 14h8M8 6h8M4 6h.01M4 10h.01M4 14h.01" stroke="currentColor" strokeWidth="2"/>
        </svg>
    ),
    exclude: (active = false) => (
        <svg className={`h-4 w-4 ${active ? 'text-primary' : 'text-muted-foreground'}`} viewBox="0 0 20 20" fill="none">
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2"/>
        </svg>
    ),
    zoomIn: () => (
        <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 20 20" fill="none">
            <path d="M9 9V5m0 4H5m4 0h4m-4 0v4" stroke="currentColor" strokeWidth="2"/>
            <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="2"/>
            <path d="M13.5 13.5L18 18" stroke="currentColor" strokeWidth="2"/>
        </svg>
    ),
    zoomOut: () => (
        <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 20 20" fill="none">
            <path d="M5 9h8" stroke="currentColor" strokeWidth="2"/>
            <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="2"/>
            <path d="M13.5 13.5L18 18" stroke="currentColor" strokeWidth="2"/>
        </svg>
    ),
    fit: () => (
        <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 20 20" fill="none">
            <path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4" stroke="currentColor" strokeWidth="2"/>
        </svg>
    ),
    grid: (active = false) => (
        <svg className={`h-4 w-4 ${active ? 'text-primary' : 'text-muted-foreground'}`} viewBox="0 0 20 20" fill="none">
            <path d="M3 7h14M3 13h14M7 3v14M13 3v14" stroke="currentColor" strokeWidth="2"/>
        </svg>
    ),
    minimap: (active = false) => (
        <svg className={`h-4 w-4 ${active ? 'text-primary' : 'text-muted-foreground'}`} viewBox="0 0 20 20" fill="none">
            <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="2"/>
            <rect x="6" y="7" width="6" height="6" rx="1" fill="currentColor"/>
        </svg>
    ),
    chevronDown: () => (
        <svg className="h-3 w-3 text-muted-foreground" viewBox="0 0 20 20" fill="none">
            <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="2"/>
        </svg>
    ),
};