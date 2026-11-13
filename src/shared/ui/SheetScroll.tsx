import { useEffect, useRef, type ComponentRef, type RefObject } from 'react';
import {
  Platform,
  ScrollView,
  TextInput,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from 'react-native';
import { KeyboardEvents } from 'react-native-keyboard-controller';

// =====================================================================
// ⌨️ The scroll area inside a bottom sheet with text fields.
//   The sheet's Modal (keyboard prop) lifts the sheet above the keyboard
//   and makes it shorter. A field low in a long sheet can then sit
//   below the part you can see. When the keyboard has opened, this
//   scrolls the field you type in into view. It only scrolls when the
//   field is hidden, and only for a field inside this sheet.
// =====================================================================

const GAP = 16;

type ScrollRef = ComponentRef<typeof ScrollView>;

export function SheetScroll({ onLayout, onScroll, scrollEventThrottle, ...props }: ScrollViewProps) {
  const ref = useRef<ScrollRef>(null);
  const top = useRef(0);
  const height = useRef(0);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let frame = 0;
    const sub = KeyboardEvents.addListener('keyboardDidShow', () => {
      cancelAnimationFrame(frame);
      // one frame later: the sheet has its new, shorter size
      frame = requestAnimationFrame(() => showFocused(ref, top, height));
    });
    return () => {
      cancelAnimationFrame(frame);
      sub.remove();
    };
  }, []);

  return (
    <ScrollView
      ref={ref}
      keyboardShouldPersistTaps="handled"
      {...props}
      scrollEventThrottle={scrollEventThrottle ?? 32}
      onLayout={(e: LayoutChangeEvent) => {
        height.current = e.nativeEvent.layout.height;
        onLayout?.(e);
      }}
      onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
        top.current = e.nativeEvent.contentOffset.y;
        onScroll?.(e);
      }}
    />
  );
}

function showFocused(ref: RefObject<ScrollRef | null>, top: RefObject<number>, height: RefObject<number>) {
  const sv = ref.current;
  const input = TextInput.State.currentlyFocusedInput();
  const inner = sv?.getInnerViewRef();
  if (!sv || !input || !inner || !height.current) return;
  // y of the field inside this sheet's content; fails (and we do nothing)
  // when the field is not inside this sheet
  input.measureLayout(
    inner,
    (_x, y, _w, h) => {
      const seen = top.current;
      const view = height.current;
      if (y + h + GAP > seen + view) {
        // below what you see: bring its bottom up (a tall field: its top)
        sv.scrollTo({ y: Math.max(0, Math.min(y - GAP, y + h + GAP - view)), animated: true });
      } else if (y - GAP < seen) {
        sv.scrollTo({ y: Math.max(0, y - GAP), animated: true });
      }
    },
    () => {},
  );
}

/**
 * A ref for a text field that should get the keyboard when its sheet opens.
 * Use it instead of autoFocus in a sheet: the keyboard then opens after the
 * sheet is on screen, so the sheet hears it and moves up above it (with
 * autoFocus the keyboard could open before that, and cover the sheet).
 */
export function useSheetFocus() {
  const ref = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), Platform.OS === 'web' ? 0 : 350);
    return () => clearTimeout(t);
  }, []);
  return ref;
}
