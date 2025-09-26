// playground/src/App.tsx
import React from 'react';
import 'reactflow/dist/style.css';
import '@/styles/global.css';

// shadcn components from the host app
import {ResizablePanelGroup, ResizablePanel, ResizableHandle} from '@/components/ui/resizable';
import {Tabs, TabsList, TabsTrigger, TabsContent} from '@/components/ui/tabs';
import {Drawer, DrawerTrigger, DrawerContent, DrawerHeader, DrawerTitle, DrawerClose} from '@/components/ui/drawer';
import {Button} from '@/components/ui/button';
import {Separator} from '@/components/ui/separator';
import {cn} from '@/lib/utils';

import {UiProvider} from 'digital-service-ui-builder/react/workspace/ui-bridge';
import {WorkspaceLayout} from 'digital-service-ui-builder/react/workspace/WorkspaceLayout';

export default function App() {
    return (
        <UiProvider
            components={{
                ResizablePanelGroup, ResizablePanel, ResizableHandle,
                Tabs, TabsList, TabsTrigger, TabsContent,
                Drawer, DrawerTrigger, DrawerContent, DrawerHeader, DrawerTitle, DrawerClose,
                Button, Separator, cn,
            }}
        >
            <WorkspaceLayout/>
        </UiProvider>
    );
}