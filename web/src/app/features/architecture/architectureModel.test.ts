import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_EDGES,
  ARCHITECTURE_FLOWS,
  ARCHITECTURE_SUBSYSTEMS,
  architectureComponent,
  searchArchitecture,
} from "./architectureModel";

describe("architectureModel", () => {
  it("uses unique subsystem and component identities with source paths", () => {
    const subsystemIds = ARCHITECTURE_SUBSYSTEMS.map((subsystem) => subsystem.id);
    expect(new Set(subsystemIds).size).toBe(subsystemIds.length);

    for (const subsystem of ARCHITECTURE_SUBSYSTEMS) {
      const componentIds = subsystem.components.map((component) => component.id);
      expect(new Set(componentIds).size).toBe(componentIds.length);
      expect(subsystem.components.length).toBeGreaterThan(0);
      expect(subsystem.sourceRoot).not.toMatch(/^\//);
      for (const component of subsystem.components) {
        expect(component.paths.length).toBeGreaterThan(0);
        expect(component.paths.every((path) => !path.startsWith("/"))).toBe(true);
      }
    }
  });

  it("keeps every edge and guided-flow reference inside the model", () => {
    const subsystemIds = new Set(ARCHITECTURE_SUBSYSTEMS.map((subsystem) => subsystem.id));

    for (const edge of ARCHITECTURE_EDGES) {
      expect(subsystemIds.has(edge.from)).toBe(true);
      expect(subsystemIds.has(edge.to)).toBe(true);
      expect(edge.from).not.toBe(edge.to);
    }

    for (const flow of ARCHITECTURE_FLOWS) {
      expect(flow.steps.length).toBeGreaterThan(1);
      for (const step of flow.steps) {
        expect(subsystemIds.has(step.subsystemId)).toBe(true);
        if (step.componentId) {
          expect(architectureComponent(step.subsystemId, step.componentId)).not.toBeNull();
        }
      }
    }
  });

  it("searches responsibilities, component mechanics, and exact source paths", () => {
    expect(searchArchitecture("cancelled superseded run")[0]).toMatchObject({
      subsystemId: "process",
    });
    expect(searchArchitecture("whatsapp media")).toEqual(expect.arrayContaining([
      expect.objectContaining({ subsystemId: "adapters", componentId: "whatsapp" }),
    ]));
    expect(searchArchitecture("ripgit/src/hyperspace.rs")).toEqual(expect.arrayContaining([
      expect.objectContaining({ subsystemId: "ripgit", componentId: "hyperspace" }),
    ]));
    expect(searchArchitecture("   ")).toEqual([]);
  });
});
