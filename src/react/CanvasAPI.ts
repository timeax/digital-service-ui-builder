import type { GraphSnapshot } from '../schema/graph';
import type { ServiceProps } from '../schema';

export interface ICanvasAPI<NodeData = unknown, EdgeData = unknown> {
  getGraph(): GraphSnapshot<NodeData, EdgeData> | undefined;
  setGraph(graph: GraphSnapshot<NodeData, EdgeData>): void;
  getService(): ServiceProps | undefined;
  setService(service: ServiceProps): void;
}

export class CanvasAPI<NodeData = unknown, EdgeData = unknown> implements ICanvasAPI<NodeData, EdgeData> {
  private graph?: GraphSnapshot<NodeData, EdgeData>;
  private service?: ServiceProps;

  getGraph(): GraphSnapshot<NodeData, EdgeData> | undefined {
    return this.graph;
  }
  setGraph(graph: GraphSnapshot<NodeData, EdgeData>): void {
    this.graph = graph;
  }
  getService(): ServiceProps | undefined {
    return this.service;
  }
  setService(service: ServiceProps): void {
    this.service = service;
  }
}
