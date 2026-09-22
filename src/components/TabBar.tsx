/**
 * 格物 · 底部标签栏
 *
 * 五格：物品 / 相册 / 录入（中央突起）/ 提醒 / 我的。
 *
 * 决策记录（见视觉稿说明）：位置视图不占底部 Tab，改挂在「物品」页右上角
 * 的「列表 / 位置」切换器上 —— 否则低频入口会挤掉高频入口。
 * 中央的「录入」做成品牌色圆形按钮并抬升：连续录入是 V1 的成败关键，
 * 界面要推着用户往前走。
 *
 * 实现注记：不接 React Navigation 的 tabPress 事件拦截机制 ——
 * TabBar 完全由本组件渲染，直接 navigate 即可，少一层类型耦合。
 */

import { Ionicons } from '@expo/vector-icons';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Palette, Radius, Shadow, Space } from '@/constants/theme';
import { Label, Meta } from './ui/typography';
import { makeStyles } from '@/lib/theme';

type IconName = keyof typeof Ionicons.glyphMap;

interface TabMeta {
  name: string;
  label: string;
  icon: IconName;
  iconActive: IconName;
}

export const TAB_ORDER: TabMeta[] = [
  { name: 'index', label: '物品', icon: 'cube-outline', iconActive: 'cube' },
  { name: 'album', label: '相册', icon: 'images-outline', iconActive: 'images' },
  { name: 'compose', label: '录入', icon: 'add', iconActive: 'add' },
  { name: 'alerts', label: '提醒', icon: 'notifications-outline', iconActive: 'notifications' },
  { name: 'mine', label: '我的', icon: 'person-outline', iconActive: 'person' },
];

/** 只声明本组件真正用到的能力，避免复刻 React Navigation 的重载签名 */
export interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: { navigate: (name: string) => void };
  /** 提醒角标数，由 (tabs)/_layout 注入 */
  badgeCount?: number;
}

export default function TabBar({ state, navigation, badgeCount = 0 }: TabBarProps) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, Space.sm) }]}>
      {TAB_ORDER.map((tab) => {
        const routeIndex = state.routes.findIndex((r) => r.name === tab.name);
        const focused = routeIndex === state.index;

        const onPress = () => {
          if (!focused && routeIndex >= 0) {
            navigation.navigate(tab.name);
          }
        };

        if (tab.name === 'compose') {
          return (
            <Pressable
              key={tab.name}
              accessibilityRole="button"
              accessibilityLabel="录入新物品"
              onPress={onPress}
              style={styles.cell}>
              <View style={styles.centerButton}>
                <Ionicons name="add" size={26} color={Palette.onAccent} />
              </View>
            </Pressable>
          );
        }

        return (
          <Pressable
            key={tab.name}
            accessibilityRole="button"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={tab.label}
            onPress={onPress}
            style={styles.cell}>
            <View>
              <Ionicons
                name={focused ? tab.iconActive : tab.icon}
                size={21}
                color={focused ? Palette.brand : Palette.ink3}
              />
              {tab.name === 'alerts' && badgeCount > 0 ? (
                <View style={styles.badge}>
                  <Meta color={Palette.onAccent} style={styles.badgeText}>
                    {badgeCount > 99 ? '99+' : String(badgeCount)}
                  </Meta>
                </View>
              ) : null}
            </View>
            <Label style={[styles.label, { color: focused ? Palette.brand : Palette.ink3 }]}>
              {tab.label}
            </Label>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((Palette) => ({
  bar: {
    flexDirection: 'row',
    backgroundColor: Palette.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line2,
    paddingTop: Space.sm,
    ...Platform.select({ android: { elevation: 8 }, default: {} }),
  },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', gap: 3, paddingVertical: 2 },
  label: { fontSize: 10.5 },
  centerButton: {
    width: 46,
    height: 46,
    borderRadius: Radius.chip,
    backgroundColor: Palette.brand,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -14,
    ...Shadow.raised,
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: Palette.clay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 10, fontWeight: '600' },
}));
