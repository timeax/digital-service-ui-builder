import React from 'react';
import type { EditorSnapshot } from '../schema/editor';
import type { GraphSnapshot } from '../schema/graph';
import type { ServiceProps } from '../schema';

export interface WorkspaceProps {
  service?: ServiceProps;
  graph?: GraphSnapshot;
  snapshot?: EditorSnapshot;
  rightTabRender?: React.ReactNode;
}

export const Workspace: React.FC<WorkspaceProps> = ({ service, graph, snapshot, rightTabRender }) => {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr 340px', height: '100%', width: '100%', fontFamily: 'sans-serif' }}>
      {/* Left Panel */}
      <aside style={{ borderRight: '1px solid #eee', padding: 12 }}>
        <h3 style={{ margin: '8px 0' }}>Service</h3>
        {service ? (
          <div>
            <div><strong>Name:</strong> {service.name}</div>
            <div><strong>Version:</strong> {service.version}</div>
            <div><strong>Sections:</strong> {service.sections.length}</div>
          </div>
        ) : (
          <div style={{ color: '#888' }}>No service loaded</div>
        )}
      </aside>

      {/* Middle Panel (Canvas placeholder) */}
      <main style={{ padding: 12 }}>
        <h3 style={{ margin: '8px 0' }}>Canvas</h3>
        {graph ? (
          <div>
            <div><strong>Nodes:</strong> {graph.nodes.length}</div>
            <div><strong>Edges:</strong> {graph.edges.length}</div>
          </div>
        ) : (
          <div style={{ color: '#888' }}>No graph snapshot</div>
        )}
      </main>

      {/* Right Panel */}
      <aside style={{ borderLeft: '1px solid #eee', padding: 12 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button type="button">Comments</button>
          <button type="button">Custom</button>
        </div>
        <div>
          {snapshot?.comments?.length ? (
            <ul>
              {snapshot.comments.map((c) => (
                <li key={c.id}>
                  <strong>{c.author}:</strong> {c.message}
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ color: '#888' }}>No comments</div>
          )}
        </div>
        {rightTabRender}
      </aside>
    </div>
  );
};
