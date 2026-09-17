// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ModalDialog } from "@/components/modal-dialog";
import {
  Badge,
  Button,
  Card,
  Cluster,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  LoadingState,
  PageHeader,
  Section,
  Select,
  Stack,
  Table,
  TableScroll,
  Textarea,
} from "@/components/ui";

describe("button primitives", () => {
  it("forwards a ref and preserves native attributes and custom classes", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref} tone="primary" name="save" data-testid="save" className="wide" aria-describedby="help">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(ref.current).toBe(button);
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("name", "save");
    expect(button).toHaveAttribute("data-testid", "save");
    expect(button).toHaveAttribute("aria-describedby", "help");
    expect(button).toHaveClass("btn", "primary", "wide");
  });

  it("does not submit an actual form by default, but submits with explicit type submit", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={submit}>
      <Button>Not submit</Button>
      <Button type="submit">Submit</Button>
    </form>);
    await user.click(screen.getByRole("button", { name: "Not submit" }));
    expect(submit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled buttons inert and still allows an onClick handler on enabled buttons", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<><Button onClick={onClick}>Enabled</Button><Button disabled onClick={onClick}>Disabled</Button></>);
    await user.click(screen.getByRole("button", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Disabled" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Disabled" })).toBeDisabled();
  });

  it("gives IconButton an accessible name, title, ref, and no accidental form submit", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLButtonElement>();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const onClick = vi.fn();
    render(<form onSubmit={submit}><IconButton ref={ref} label="Close panel" onClick={onClick}>×</IconButton></form>);
    const button = screen.getByRole("button", { name: "Close panel" });
    expect(ref.current).toBe(button);
    expect(button).toHaveAttribute("title", "Close panel");
    expect(button).toHaveClass("icon-button", "btn");
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("field and native control primitives", () => {
  it.each([
    ["input", Input],
    ["select", Select],
    ["textarea", Textarea],
  ])("renders a real %s with native attrs, ref, class, and style", (_name, Control) => {
    const ref = createRef<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>();
    const props = { ref, id: "control", name: "value", required: true, disabled: true, className: "custom", style: { color: "red" } };
    const { container } = render(<Control {...props}>{_name === "select" ? <option>One</option> : undefined}</Control>);
    const control = container.querySelector<HTMLElement>("#control")!;
    expect(ref.current).toBe(control);
    expect(control).toHaveClass("input", "custom");
    expect(control.style.color).toBe("red");
    expect(control).toHaveAttribute("name", "value");
    expect(control).toBeDisabled();
    expect(control).toBeRequired();
  });

  it("associates an explicit label and error, while preserving an existing describedby", () => {
    render(<Field label="Email" htmlFor="email" hint="Use your work address" error="Email is invalid">
      <Input id="email" aria-describedby="external-help" />
    </Field>);
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).toHaveAttribute("aria-describedby", expect.stringContaining("external-help"));
    expect(input).toHaveAttribute("aria-describedby", expect.stringContaining("email-error"));
    expect(screen.getByText("Email is invalid").closest('[role="alert"]')).toBeInTheDocument();
    expect(screen.queryByText("Use your work address")).not.toBeInTheDocument();
  });

  it("uses a hint association when there is no error", () => {
    render(<Field label="Name" htmlFor="name" hint="Shown publicly"><Input id="name" /></Field>);
    const input = screen.getByRole("textbox", { name: "Name" });
    const hint = screen.getByText("Shown publicly");
    expect(input).toHaveAttribute("aria-describedby", hint.id);
    expect(hint).toHaveClass("sub");
  });

  it("renders unusual multiple children without dropping them or throwing", () => {
    render(<Field label="Filters" htmlFor="first" hint="Optional">
      <><Input id="first" /><Select aria-label="Second"><option>One</option></Select></>
    </Field>);
    expect(screen.getByRole("textbox", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Second" })).toBeInTheDocument();
    expect(screen.getByText("Optional")).toBeInTheDocument();
  });
});

describe("composition, status, and table primitives", () => {
  it("forwards refs, native attrs, styles, and layout gaps", () => {
    const stackRef = createRef<HTMLDivElement>();
    const clusterRef = createRef<HTMLDivElement>();
    render(<Stack ref={stackRef} data-kind="stack" gap="12px" style={{ color: "red" }} className="extra"><span>Stacked</span></Stack>);
    render(<Cluster ref={clusterRef} data-kind="cluster" gap="6px" style={{ color: "blue" }} className="extra"><span>Grouped</span></Cluster>);
    expect(stackRef.current).toHaveAttribute("data-kind", "stack");
    expect(stackRef.current).toHaveClass("stack", "extra");
    expect(stackRef.current).toHaveStyle("--stack-gap: 12px");
    expect(stackRef.current?.style.color).toBe("red");
    expect(clusterRef.current).toHaveAttribute("data-kind", "cluster");
    expect(clusterRef.current).toHaveClass("cluster", "extra");
    expect(clusterRef.current).toHaveStyle("--cluster-gap: 6px");
    expect(clusterRef.current?.style.color).toBe("blue");
  });

  it("renders semantic page and section headings with actions", () => {
    const ref = createRef<HTMLElement>();
    // Descrições de cabeçalho foram removidas de todas as telas: PageHeader
    // não aceita mais `description` — título e ações bastam.
    render(<PageHeader ref={ref} title="Dashboard" actions={<Button>Refresh</Button>} />);
    render(<Section title="Recent activity" description="Latest events" actions={<Button>View all</Button>}><p>Rows</p></Section>);
    render(<Card data-testid="summary-card" aria-label="Summary"><p>Card contents</p></Card>);
    expect(ref.current).toHaveClass("pagehead");
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByText("Overview")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Recent activity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View all" })).toBeInTheDocument();
    expect(screen.getByText("Latest events")).toBeInTheDocument();
    expect(screen.getByTestId("summary-card")).toHaveClass("card");
    expect(screen.getByLabelText("Summary")).toHaveTextContent("Card contents");
  });

  it("preserves Badge tone, native attrs, style, and accessible text", () => {
    render(<Badge tone="success" data-status="active" style={{ color: "green" }} className="custom">Active</Badge>);
    const badge = screen.getByText("Active");
    expect(badge).toHaveClass("badge", "badge--success", "custom");
    expect(badge).toHaveAttribute("data-status", "active");
    expect(badge.style.color).toBe("green");
  });

  it("exposes status semantics for empty, error, and loading states", () => {
    render(<><EmptyState title="No records">Try again later</EmptyState><ErrorState title="Failed">Retry</ErrorState><LoadingState label="Loading records" /></>);
    const statuses = screen.getAllByRole("status");
    expect(statuses[0]).toHaveTextContent("No recordsTry again later");
    expect(screen.getByText("Failed").closest('[role="alert"]')).toHaveTextContent("FailedRetry");
    expect(statuses[1]).toHaveAttribute("aria-busy", "true");
  });

  it("keeps table contents accessible and preserves table attrs and wrapper attrs", () => {
    render(<Table aria-label="Users" data-testid="table"><caption>User list</caption><thead><tr><th scope="col">Name</th></tr></thead><tbody><tr><td>Ana</td></tr></tbody></Table>);
    render(<TableScroll data-testid="scroll"><span>Scrollable table</span></TableScroll>);
    expect(screen.getByRole("table", { name: "Users" })).toHaveAttribute("data-testid", "table");
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("scope", "col");
    expect(screen.getByRole("cell", { name: "Ana" })).toBeInTheDocument();
    expect(screen.getByTestId("scroll")).toHaveClass("table-scroll");
  });
});

describe("ModalDialog production behavior", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open dialog</button>{open && <ModalDialog labelledBy="dialog-title" describedBy="dialog-description" onClose={() => setOpen(false)}>
      <h2 id="dialog-title">Confirm</h2><p id="dialog-description">Choose an option</p><button data-autofocus>First</button><button>Last</button>
    </ModalDialog>}</>;
  }

  it("moves focus into the dialog, traps Tab in both directions, closes on Escape, and restores focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Confirm", description: "Choose an option" });
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes only when the backdrop itself is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ModalDialog labelledBy="title" onClose={onClose}><h2 id="title">Dialog</h2><button>Inside</button></ModalDialog>);
    const dialog = screen.getByRole("dialog", { name: "Dialog" });
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
