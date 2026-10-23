import { useCanGoBack, useLocation, useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "../ui/button";

declare module "@tanstack/react-router" {
  interface HistoryState {
    threadLinkOrigin?: boolean;
  }
}

export function ThreadLinkBackButton() {
  const fromThread = useLocation({ select: (location) => location.state.threadLinkOrigin });
  const canGoBack = useCanGoBack();
  const router = useRouter();
  if (!fromThread || !canGoBack) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Back to previous thread"
      title="Back to previous thread"
      onClick={() => router.history.back()}
    >
      <ArrowLeftIcon />
    </Button>
  );
}
