import { createBoatEnvironment } from "@t3tools/client-runtime/state/boat";
import { connectionAtomRuntime } from "../connection/runtime";

export const boatEnvironment = createBoatEnvironment(connectionAtomRuntime);
