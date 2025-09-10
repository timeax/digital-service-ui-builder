import type { UUID } from './index';

export interface GraphNode<Data = unknown> {
  id: UUID;
  type?: string;
  label?: string;
  position: { x: number; y: number };
  data?: Data;
}

export interface GraphEdge<Data = unknown> {
  id: UUID;
  source: UUID;
  target: UUID;
  label?: string;
  data?: Data;
}

export interface GraphSnapshot<NodeData = unknown, EdgeData = unknown> {
  id: UUID;
  nodes: GraphNode<NodeData>[];
  edges: GraphEdge<EdgeData>[];
  createdAt?: string;
  updatedAt?: string;
}
