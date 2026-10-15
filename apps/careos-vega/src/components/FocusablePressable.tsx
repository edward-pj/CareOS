import React, {useCallback, useState} from 'react';
import {Pressable, StyleSheet, Text, type StyleProp, type ViewStyle} from 'react-native';
import {colors, space, type} from '../theme';

interface Props {
  /** Visible text. It is also the accessible name, so no aria-label is set (avoids duplicating on-screen text). */
  label: string;
  onPress: () => void;
  selected?: boolean;
  hasTVPreferredFocus?: boolean;
  style?: StyleProp<ViewStyle>;
}

// Focus uses a physical change (border + scale), not colour alone: required for accessibility compliance.
export const FocusablePressable = React.memo(function FocusablePressable({
  label,
  onPress,
  selected,
  hasTVPreferredFocus,
  style,
}: Props) {
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);

  return (
    <Pressable
      role="button"
      aria-selected={selected}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={onFocus}
      onBlur={onBlur}
      onPress={onPress}
      style={[styles.base, selected && styles.selected, focused && styles.focused, style]}>
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  base: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    margin: space.xs,
    borderRadius: 12,
    borderWidth: 4,
    borderColor: 'transparent',
    backgroundColor: colors.panel,
  },
  selected: {backgroundColor: colors.teal},
  focused: {borderColor: colors.focus, transform: [{scale: 1.05}]},
  text: {color: colors.text, fontSize: type.body, fontWeight: '600'},
});
