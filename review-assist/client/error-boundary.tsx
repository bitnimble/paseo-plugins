import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { detailsOf } from "../shared/errors";
import { Button } from "./controls";
import { MONOSPACE } from "./palette";

interface Props {
  readonly theme: PluginTheme;
  readonly children: ReactNode;
}

interface State {
  readonly details: string | null;
}

/** Shows what crashed the panel in full, where the host would show only the message. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { details: null };

  static getDerivedStateFromError(error: unknown): State {
    return { details: detailsOf(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[review-assist] The review panel crashed\n\n${detailsOf(error)}\n${info.componentStack ?? ""}`);
  }

  render(): ReactNode {
    const { theme, children } = this.props;
    const { details } = this.state;
    if (details == null) return children;
    return (
      <View style={{ flex: 1, gap: 12, padding: 16, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 14, fontWeight: "600" }}>
          The review panel crashed
        </Text>
        <View style={{ flexDirection: "row" }}>
          <Button theme={theme} label="Try again" icon="RefreshCw" onPress={() => this.setState({ details: null })} />
        </View>
        <ScrollView style={{ flex: 1 }}>
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: MONOSPACE, fontSize: 12 }}>
            {details}
          </Text>
        </ScrollView>
      </View>
    );
  }
}
