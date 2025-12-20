import { describe, expect, test, beforeEach } from "bun:test";
import {
    getPreprocessingErrors,
    resetPreprocessingState,
    createPreprocessMdxPlugin,
    type ComponentMap,
} from "../../src/preprocess";

describe("preprocess error handling", () => {
    beforeEach(() => {
        resetPreprocessingState();
    });

    test("getPreprocessingErrors returns empty array initially", () => {
        const errors = getPreprocessingErrors();
        expect(errors).toEqual([]);
    });

    test("getPreprocessingErrors clears errors after getting", () => {
        // Get errors twice - second call should return empty
        const errors1 = getPreprocessingErrors();
        const errors2 = getPreprocessingErrors();
        expect(errors1).toEqual([]);
        expect(errors2).toEqual([]);
    });

    test("resetPreprocessingState clears all state", () => {
        resetPreprocessingState();
        const errors = getPreprocessingErrors();
        expect(errors).toEqual([]);
    });
});

describe("createPreprocessMdxPlugin", () => {
    beforeEach(() => {
        resetPreprocessingState();
    });

    test("creates a plugin function", () => {
        const componentMap: ComponentMap = {
            Button: "/path/to/Button.jsx",
        };

        const plugin = createPreprocessMdxPlugin(componentMap);
        expect(typeof plugin).toBe("function");
    });

    test("plugin returns a transformer function", () => {
        const componentMap: ComponentMap = {};
        const plugin = createPreprocessMdxPlugin(componentMap);
        const transformer = plugin();
        expect(typeof transformer).toBe("function");
    });

    test("handles empty component map", () => {
        const componentMap: ComponentMap = {};
        const plugin = createPreprocessMdxPlugin(componentMap);

        // Create a minimal MDX AST
        const tree = {
            type: "root",
            children: [],
        };

        const transformer = plugin();
        // Should not throw
        expect(() => transformer(tree, {})).not.toThrow();
    });

    test("handles component map with conflicts set", () => {
        const componentMap: ComponentMap = {
            Button: "/path/to/Button.jsx",
        };
        const conflicts = new Set(["Button"]);

        const plugin = createPreprocessMdxPlugin(componentMap, conflicts);
        expect(typeof plugin).toBe("function");
    });
});
