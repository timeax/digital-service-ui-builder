import type { CanvasAPI } from './api';
import type { Editor } from './editor';

/**
 * Install handlers that translate CanvasAPI events into Editor commands.
 * Returns a disposer to unhook all listeners.
 */
export function installEditorBridge(api: CanvasAPI, editor: Editor) {
    const off: Array<() => void> = [];

    // ───────────────────────────
    // Wires (bind/include/exclude/service)
    // ───────────────────────────
    off.push(api.on('wire:commit', ({ kind, from, to }) => {
        // kind: 'bind' | 'include' | 'exclude' | 'service'
        // from: string (id) | number (serviceId for 'service')
        // to:   string (id)
        editor.connect(kind as any, from as any, to);
    }));

    // off.push(api.on('wire:remove', ({ kind, from, to }) => {
    //     editor.disconnect(kind as any, from as any, to);
    // }));
    //
    // // ───────────────────────────
    // // Node edits
    // // ───────────────────────────
    // off.push(api.on('node:rename', ({ id, label }) => {
    //     editor.editLabel(id, label);
    // }));
    //
    // off.push(api.on('node:remove', ({ id }) => {
    //     editor.remove(id);
    // }));
    //
    // off.push(api.on('node:setService', ({ id, serviceId, pricing_role }) => {
    //     // Only ensure it exists (host provides checker/map via EditorOptions)
    //     editor.setService(id, { service_id: serviceId, pricing_role });
    // }));
    //
    // // ───────────────────────────
    // // Placement / ordering (array order, not XY)
    // // ───────────────────────────
    // off.push(api.on('node:place', ({ id, scopeTagId, beforeId, afterId, index }) => {
    //     editor.placeNode(id, { scopeTagId, beforeId, afterId, index });
    // }));
    //
    // off.push(api.on('option:place', ({ optionId, beforeId, afterId, index }) => {
    //     editor.placeOption(optionId, { beforeId, afterId, index });
    // }));
    //
    // // ───────────────────────────
    // // Options CRUD
    // // ───────────────────────────
    // off.push(api.on('option:add', ({ fieldId, input, reply }) => {
    //     const newId = editor.addOption(fieldId, input);
    //     reply?.(newId); // let the UI know which id was created
    // }));
    //
    // off.push(api.on('option:update', ({ optionId, patch }) => {
    //     editor.updateOption(optionId, patch);
    // }));
    //
    // off.push(api.on('option:remove', ({ optionId }) => {
    //     editor.removeOption(optionId);
    // }));
    //
    // // ───────────────────────────
    // // Constraints toggle (if you surface this in the canvas UI)
    // // ───────────────────────────
    // off.push(api.on('tag:setConstraint', ({ tagId, flag, value }) => {
    //     editor.setConstraint(tagId, flag, value);
    // }));
    //
    // // ───────────────────────────
    // // Selection & viewport are typically handled inside CanvasAPI already.
    // // If you need to reflect editor transactions specially, listen here:
    // // ───────────────────────────
    // off.push(api.on('editor:undo', () => {
    //     // noop: CanvasAPI should re-render from editor snapshot automatically
    // }));
    // off.push(api.on('editor:redo', () => {
    //     // noop
    // }));

    // return disposer
    return () => { off.forEach(fn => fn()); };
}