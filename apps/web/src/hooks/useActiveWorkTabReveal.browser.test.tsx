import "../index.css";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { ScrollArea } from "../components/ui/scroll-area";
import { useActiveWorkTabReveal } from "./useActiveWorkTabReveal";

function Fixture({
  active,
  width,
  ready = true,
}: {
  active: number;
  width: number;
  ready?: boolean;
}) {
  const revealRef = useActiveWorkTabReveal();
  if (!ready) return null;
  return (
    <div ref={revealRef}>
      <button data-focus>Composer</button>
      <div style={{ width }}>
        <ScrollArea className="h-12">
          <div className="flex w-max">
            {Array.from({ length: 8 }, (_, index) => (
              <button
                key={index}
                data-active-work-tab={active === index ? "" : undefined}
                style={{ width: 100, flexShrink: 0 }}
              >
                Pin {index + 1}
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

it("reveals the active pin after hydration, navigation and resize without moving focus or the page", async () => {
  await using screen = await render(<Fixture active={7} width={200} ready={false} />);
  await screen.rerender(<Fixture active={7} width={200} />);
  const root = screen.container;
  const viewport = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  const focus = root.querySelector<HTMLButtonElement>("[data-focus]")!;
  await vi.waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(500));
  await screen.rerender(<Fixture active={0} width={800} />);
  focus.focus();
  const pageY = window.scrollY;
  await screen.rerender(<Fixture active={7} width={800} />);
  await screen.rerender(<Fixture active={7} width={200} />);
  await vi.waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(500));
  expect(document.activeElement).toBe(focus);
  expect(window.scrollY).toBe(pageY);
  await screen.rerender(<Fixture active={0} width={200} />);
  await vi.waitFor(() => expect(viewport.scrollLeft).toBe(0));
});
