import React, {type ErrorInfo, type ReactNode} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {colors, space, type} from '../theme';

interface State {
  error?: Error;
}

export class ErrorBoundary extends React.Component<{children: ReactNode}, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return {error};
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('CareOS UI error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <Text role="alert" style={styles.text}>
            Something went wrong. Restart CareOS.
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.slate, padding: space.xl},
  text: {color: colors.crimson, fontSize: type.title},
});
