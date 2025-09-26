// src/react/workspace/ui-bridge.tsx
import React, {createContext, useContext} from 'react';

export interface UiPrimitives {
    // resizable
    ResizablePanelGroup: React.ComponentType<any>;
    ResizablePanel: React.ComponentType<any>;
    ResizableHandle: React.ComponentType<any>;
    // tabs
    Tabs: React.ComponentType<any>;
    TabsList: React.ComponentType<any>;
    TabsTrigger: React.ComponentType<any>;
    TabsContent: React.ComponentType<any>;
    // drawer
    Drawer: React.ComponentType<any>;
    DrawerTrigger: React.ComponentType<any>;
    DrawerContent: React.ComponentType<any>;
    DrawerHeader: React.ComponentType<any>;
    DrawerTitle: React.ComponentType<any>;
    DrawerClose: React.ComponentType<any>;
    // misc
    Button: React.ComponentType<any>;
    Separator: React.ComponentType<any>;
    cn: (...classes: any[]) => string; // className merge helper
}

const UiCtx = createContext<UiPrimitives | null>(null);

export function UiProvider({components, children}: { components: UiPrimitives; children: React.ReactNode }) {
    return <UiCtx.Provider value={components}>{children}</UiCtx.Provider>;
}

export function useUi(): UiPrimitives {
    const v = useContext(UiCtx);
    if (!v) throw new Error('UiProvider is missing (host must inject UI primitives).');
    return v;
}