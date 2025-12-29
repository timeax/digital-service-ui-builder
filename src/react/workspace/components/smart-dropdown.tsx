// components/smart-dropdown.tsx
import * as React from "react";
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuGroup,
    DropdownMenuCheckboxItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSub,
    DropdownMenuSubTrigger,
    DropdownMenuSubContent,
    DropdownMenuPortal,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/* ───────────────────────────── Types ───────────────────────────── */

type BaseItem = {
    action?: string;
    label?: React.ReactNode;
    shortcut?: React.ReactNode;
    icon?: React.ReactNode;
    disabled?: boolean;
    danger?: boolean;
    meta?: Record<string, unknown>;
    onSelect?: (item: MenuEntry, ev: Event | React.SyntheticEvent) => void;
    className?: string;
};

export type MenuItem = BaseItem & {
    type?: "item";
    href?: string;
    target?: "_blank" | "_self" | "_parent" | "_top";
};

export type MenuSeparator = { type: "separator" };

export type MenuLabel = {
    type: "label";
    label: React.ReactNode;
    className?: string;
};

export type MenuCheckbox = BaseItem & {
    type: "checkbox";
    checked: boolean;
    onCheckedChange?: (next: boolean) => void;
};

export type MenuRadioGroup = {
    type: "radio-group";
    value: string;
    onValueChange?: (v: string) => void;
    items: Array<(BaseItem & { type?: "radio"; value: string }) | MenuSeparator>;
};

export type MenuSubmenu = BaseItem & {
    type: "submenu";
    items: MenuEntry[];
    contentClassName?: string;
};

export type MenuGroup = {
    type: "group";
    label?: React.ReactNode;
    items: MenuEntry[];
    className?: string;
    labelClassName?: string;
};

export type MenuEntry =
    | MenuItem
    | MenuSeparator
    | MenuLabel
    | MenuCheckbox
    | MenuRadioGroup
    | MenuSubmenu
    | MenuGroup;

export type SmartDropdownProps = {
    menu: MenuEntry[];

    onAction?: (action: string, item: MenuEntry) => void;
    renderItem?: (item: MenuEntry, defaultNode: React.ReactNode) => React.ReactNode;

    /** Either children OR trigger (children takes precedence if both). */
    children?: React.ReactNode; // used as trigger when provided
    trigger?: React.ReactNode;
    asChild?: boolean; // default true for custom trigger

    open?: boolean;
    onOpenChange?: (open: boolean) => void;

    // Radix positioning passthrough
    align?: "start" | "center" | "end";
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
    collisionPadding?: number;

    // Class hooks
    className?: string;
    contentClassName?: string;
    itemClassName?: string;
    shortcutClassName?: string;
    groupLabelClassName?: string;
    submenuContentClassName?: string;
};

/* ───────────────────────────── Component ───────────────────────────── */

export function SmartDropdown(props: SmartDropdownProps) {
    const {
        menu,
        onAction,
        renderItem,
        children,
        trigger,
        asChild = true,
        open,
        onOpenChange,
        align,
        side,
        sideOffset,
        collisionPadding,
        className,
        contentClassName,
        itemClassName,
        shortcutClassName = "ml-auto text-xs text-muted-foreground",
        groupLabelClassName = "px-2 py-1.5 text-xs font-medium text-muted-foreground",
        submenuContentClassName,
    } = props;

    // Dev hint if both trigger+children are provided
    // @ts-expect-error
    if (window?.env?.NODE_ENV !== "production" && trigger && children) {
        // eslint-disable-next-line no-console
        console.warn(
            "[SmartDropdown] Both `children` and `trigger` were provided. Using `children` as the trigger."
        );
    }

    const resolvedTrigger =
        children ??
        trigger ?? (
            <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
            >
                Menu
            </button>
        );

    const handleSelect = React.useCallback(
        (item: MenuEntry) => (ev: Event | React.SyntheticEvent) => {
            if ("onSelect" in item && item.onSelect) {
                item.onSelect(item, ev);
                return;
            }
            const action = "action" in item ? item.action : undefined;
            if (action && onAction) onAction(action, item);
        },
        [onAction]
    );

    const renderEntries = (entries: MenuEntry[]): React.ReactNode =>
        entries.map((item, i) => {
            let node: React.ReactNode;

            switch (item.type) {
                case "separator":
                    node = <DropdownMenuSeparator key={`sep-${i}`} />;
                    break;

                case "label":
                    node = (
                        <DropdownMenuLabel
                            key={`label-${i}`}
                            className={cn(groupLabelClassName, item.className)}
                        >
                            {item.label}
                        </DropdownMenuLabel>
                    );
                    break;

                case "checkbox": {
                    const it = item as MenuCheckbox;
                    node = (
                        <DropdownMenuCheckboxItem
                            key={`chk-${i}`}
                            checked={it.checked}
                            disabled={it.disabled}
                            onCheckedChange={(v) => it.onCheckedChange?.(!!v)}
                            className={cn(itemClassName, it.className, it.danger && "text-destructive")}
                            onSelect={(e) => handleSelect(it)(e)}
                        >
                            {it.icon && <span className="mr-2">{it.icon}</span>}
                            {it.label}
                            {it.shortcut && <span className={shortcutClassName}>{it.shortcut}</span>}
                        </DropdownMenuCheckboxItem>
                    );
                    break;
                }

                case "radio-group": {
                    const rg = item as MenuRadioGroup;
                    node = (
                        <DropdownMenuRadioGroup
                            key={`rg-${i}`}
                            value={rg.value}
                            onValueChange={rg.onValueChange}
                        >
                            {rg.items.map((ri, j) =>
                                "type" in ri && ri.type === "separator" ? (
                                    <DropdownMenuSeparator key={`rg-sep-${j}`} />
                                ) : (
                                    <DropdownMenuRadioItem
                                        key={`rg-item-${j}`}
                                        value={(ri as any).value}
                                        disabled={(ri as any).disabled}
                                        className={cn(
                                            itemClassName,
                                            (ri as any).className,
                                            (ri as any).danger && "text-destructive"
                                        )}
                                        onSelect={handleSelect(ri as any)}
                                    >
                                        {(ri as any).icon && <span className="mr-2">{(ri as any).icon}</span>}
                                        {(ri as any).label}
                                        {(ri as any).shortcut && (
                                            <span className={shortcutClassName}>{(ri as any).shortcut}</span>
                                        )}
                                    </DropdownMenuRadioItem>
                                )
                            )}
                        </DropdownMenuRadioGroup>
                    );
                    break;
                }

                case "submenu": {
                    const sm = item as MenuSubmenu;
                    node = (
                        <DropdownMenuSub key={`sub-${i}`}>
                            <DropdownMenuSubTrigger
                                disabled={sm.disabled}
                                className={cn(itemClassName, sm.className, sm.danger && "text-destructive")}
                                onSelect={handleSelect(sm)}
                            >
                                {sm.icon && <span className="mr-2">{sm.icon}</span>}
                                {sm.label}
                                {sm.shortcut && <span className={shortcutClassName}>{sm.shortcut}</span>}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuPortal>
                                <DropdownMenuSubContent
                                    className={cn(submenuContentClassName ?? contentClassName)}
                                    sideOffset={6}
                                >
                                    {renderEntries(sm.items)}
                                </DropdownMenuSubContent>
                            </DropdownMenuPortal>
                        </DropdownMenuSub>
                    );
                    break;
                }

                case "group": {
                    const g = item as MenuGroup;
                    node = (
                        <DropdownMenuGroup key={`grp-${i}`} className={g.className}>
                            {g.label && (
                                <DropdownMenuLabel className={groupLabelClassName}>
                                    {g.label}
                                </DropdownMenuLabel>
                            )}
                            {renderEntries(g.items)}
                        </DropdownMenuGroup>
                    );
                    break;
                }

                case "item":
                default: {
                    const it = item as MenuItem;
                    node = (
                        <DropdownMenuItem
                            key={`itm-${i}`}
                            disabled={it.disabled}
                            className={cn(itemClassName, it.className, it.danger && "text-destructive")}
                            onSelect={handleSelect(it)}
                        >
                            {it.icon && <span className="mr-2">{it.icon}</span>}
                            <span>{it.label}</span>
                            {it.shortcut && <span className={shortcutClassName}>{it.shortcut}</span>}
                        </DropdownMenuItem>
                    );
                }
            }

            return renderItem ? renderItem(item, node) : node;
        });

    return (
        <DropdownMenu open={open} onOpenChange={onOpenChange}>
            <DropdownMenuTrigger asChild={!!(children ?? trigger) && asChild}>
                {resolvedTrigger as any}
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align={align}
                side={side}
                sideOffset={sideOffset}
                collisionPadding={collisionPadding}
                className={cn(className, contentClassName)}
            >
                {renderEntries(menu)}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/* ───────────────────────────── Example ─────────────────────────────
import { SmartDropdown, type MenuEntry } from "@/components/smart-dropdown";
import { MoreHorizontal, Edit3, Trash2, ExternalLink } from "lucide-react";

const menu: MenuEntry[] = [
  { type: "label", label: "Actions" },
  { type: "item", action: "edit", label: "Edit", icon: <Edit3 className="size-4" /> },
  {
    type: "submenu",
    label: "Share",
    action: "share",
    items: [
      { type: "item", action: "share:link", label: "Copy link" },
      { type: "item", action: "open:external", label: "Open in browser", icon: <ExternalLink className="size-4" /> },
    ],
  },
  { type: "separator" },
  { type: "checkbox", action: "pin", label: "Pinned", checked: false, onCheckedChange: (v) => console.log("pin ->", v) },
  {
    type: "radio-group",
    value: "public",
    onValueChange: (v) => console.log("visibility ->", v),
    items: [{ value: "private", label: "Private" }, { value: "team", label: "Team" }, { value: "public", label: "Public" }],
  },
  { type: "separator" },
  { type: "item", action: "delete", label: "Delete", icon: <Trash2 className="size-4" />, danger: true },
];

export function Example() {
  return (
    <SmartDropdown
      menu={menu}
      onAction={(action) => {
        if (action === "open:external") window.open("https://example.com", "_blank");
      }}
      // child-as-trigger (preferred)
      contentClassName="min-w-56"
      itemClassName="[&>[data-radix-dropdown-menu-item-indicator]]:mr-2"
    >
      <button className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
        <MoreHorizontal className="size-4" /> Options
      </button>
    </SmartDropdown>
  );
}
--------------------------------------------------------------------- */
