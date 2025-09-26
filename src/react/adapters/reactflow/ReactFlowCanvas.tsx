// src/react/adapters/reactflow/ReactFlowCanvas.tsx
import React from 'react';
import ReactFlow, {Background, Controls, MiniMap} from 'reactflow';
import 'reactflow/dist/style.css';
import {useReactFlowAdapter} from './adapter';
import type {CanvasAPI} from '../../canvas/api';

export function ReactFlowCanvas({api}: { api: CanvasAPI }) {
    const {nodes, edges, onNodesChange, onEdgesChange, onConnect, onMoveEnd, onSelectionChange} =
        useReactFlowAdapter(api);

    return (
        <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onMoveEnd={onMoveEnd}
            onSelectionChange={onSelectionChange}
            fitView
        >
            <MiniMap/>
            <Controls/>
            <Background/>
        </ReactFlow>
    );
}