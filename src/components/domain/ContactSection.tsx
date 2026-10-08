/**
 * 格物 · 联系我
 *
 * 格物没有账号、没有客服后台、也没有商店评论区 —— 想找作者只有这一条路，
 * 所以这张二维码必须真的**能用**，不能只是摆着看：
 * 可以点开放大给别人扫，也可以分享出去在微信里长按识别。
 *
 * ★ 二维码底板固定用 Palette.pure，不跟主题走。
 *   扫码靠的是「深色模块压浅色底」这个对比度，跟 App 换了哪套配色无关；
 *   深色主题下如果底板跟着变暗，二维码就直接扫不出来了。
 *   同理，图片本身的白底是烘进 PNG 的，不是样式 —— 不归皮肤管。
 */

import { Image } from 'expo-image';
import { useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, View } from 'react-native';

import { Palette, Radius, Space } from '@/constants/theme';
import { WECHAT_QR, shareWechatQr } from '@/lib/contact';
import { Button } from '../ui/controls';
import { Card, Gutter, SectionCard } from '../ui/layout';
import { Body, Meta } from '../ui/typography';
import { makeStyles } from '@/lib/theme';

/** 卡内二维码边长；再小就开始挑扫码器的对焦能力了 */
const QR_SIZE = 200;
/** 放大态的边长。屏幕最窄的机型也放得下（264 + 两边留白 < 360） */
const QR_ZOOM_SIZE = 264;

export function ContactSection() {
  const styles = useStyles();
  const [zoomed, setZoomed] = useState(false);
  const [sharing, setSharing] = useState(false);

  const onShare = async () => {
    setSharing(true);
    try {
      const ok = await shareWechatQr();
      /* 没有分享面板是设备能力问题，不是错误：给出不需要分享的两条替代路径 */
      if (!ok) {
        Alert.alert(
          '这台设备没有分享面板',
          '可以点开二维码用另一台手机扫；或者直接截屏，再在微信里从相册选这张图识别。',
        );
      }
    } catch (err) {
      Alert.alert('分享失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setSharing(false);
    }
  };

  return (
    <>
      <SectionCard title="联系我">
        <Gutter>
          <Card>
            <Body tone="ink2" style={styles.lead}>
              格物没有账号、没有客服后台，也没有商店评论区。遇到问题、想提建议，或者只是想聊聊，都可以加我微信。
            </Body>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="放大微信二维码"
              onPress={() => setZoomed(true)}
              android_ripple={{ color: Palette.ripple }}
              style={({ pressed }) => [styles.plate, pressed && styles.platePressed]}>
              <Image source={WECHAT_QR} style={styles.qr} contentFit="contain" />
            </Pressable>

            <Meta tone="ink4" style={styles.hint}>
              点一下放大；用另一台手机扫，或者分享出去在微信里长按识别。
            </Meta>

            <Button
              tone="secondary"
              icon="share-outline"
              label={sharing ? '正在打开分享…' : '分享二维码'}
              loading={sharing}
              onPress={() => void onShare()}
              style={styles.shareBtn}
            />
          </Card>
        </Gutter>
      </SectionCard>

      <Modal
        visible={zoomed}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setZoomed(false)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭二维码"
          onPress={() => setZoomed(false)}
          style={styles.backdrop}>
          <View style={styles.zoomPlate}>
            <Image source={WECHAT_QR} style={styles.zoomQr} contentFit="contain" />
          </View>
          <Meta color={Palette.pure} style={styles.zoomHint}>
            用另一台手机的微信扫一扫 · 点任意处关闭
          </Meta>
        </Pressable>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------ 样式 */

const useStyles = makeStyles((Palette) => ({
  lead: { lineHeight: 21 },
  hint: { marginTop: Space.sm, lineHeight: 18, textAlign: 'center' },
  shareBtn: { marginTop: Space.md },

  /* 白底板：见文件头，这块颜色不参与换肤 */
  plate: {
    marginTop: Space.md,
    alignSelf: 'center',
    padding: Space.md,
    borderRadius: Radius.card,
    backgroundColor: Palette.pure,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line3,
  },
  platePressed: { opacity: 0.9 },
  qr: { width: QR_SIZE, height: QR_SIZE },

  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.lg,
    padding: Space.xxl,
    backgroundColor: Palette.scrim,
  },
  zoomPlate: {
    padding: Space.lg,
    borderRadius: Radius.sheet,
    backgroundColor: Palette.pure,
  },
  zoomQr: { width: QR_ZOOM_SIZE, height: QR_ZOOM_SIZE },
  zoomHint: { textAlign: 'center' },
}));
