import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import { CREW_COLORS } from "../lib/mobileBranding";

const ThemedPath = withUniwind(Path);

export function CrewMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg accessibilityLabel="Crew" height={props.height} width={props.height} viewBox="0 0 128 128">
      <ThemedPath
        d="M100 37C91 26 80 21 65 21C39 21 21 39 21 64C21 90 40 107 65 107C80 107 92 101 101 89L87 76C81 84 74 88 65 88C49 88 40 78 40 64C40 50 49 40 65 40C74 40 81 44 87 52Z"
        color={props.color ?? (props.colorClassName ? undefined : CREW_COLORS.ink)}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
      <Path d="M65 88C74 88 81 84 87 76L101 89C92 101 80 107 65 107Z" fill={CREW_COLORS.accent} />
    </Svg>
  );
}
