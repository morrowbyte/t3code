import { Button } from "~/components/ui/button";
import { useAgentIdentityTheme } from "./useAgentIdentityTheme";

export function AgentIdentitySettings() {
  const [theme, setTheme] = useAgentIdentityTheme();
  return (
    <section aria-labelledby="agent-identity-heading" className="space-y-3">
      <h3 id="agent-identity-heading" className="text-sm font-medium">
        Agent identity
      </h3>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Agent identity style">
        <Button
          variant={theme === "neutral" ? "default" : "outline"}
          size="sm"
          aria-pressed={theme === "neutral"}
          onClick={() => setTheme("neutral")}
        >
          Neutral
        </Button>
        <Button
          variant={theme === "weasel" ? "default" : "outline"}
          size="sm"
          aria-pressed={theme === "weasel"}
          onClick={() => setTheme("weasel")}
        >
          Helferwiesel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Only on this client.</p>
    </section>
  );
}
