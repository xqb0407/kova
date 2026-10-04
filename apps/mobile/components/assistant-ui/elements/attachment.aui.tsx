import { Icon } from "@/components/ui/icon";
import { iconButtonHitSlop } from "./icon-button";
import { ImageZoom } from "./image";
import {
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react-native";
import * as ImagePicker from "expo-image-picker";
import { PlusIcon, XIcon } from "lucide-react-native";
import type { FC } from "react";
import { Image, View } from "react-native";
import { compressImage } from "@/lib/attachments/image-compress";

const useAttachmentImageUri = () =>
  useAuiState((s) => {
    const part = s.attachment.content?.find((c) => c.type === "image");
    return part?.type === "image" ? part.image : undefined;
  });

const AttachmentName: FC = () => (
  <View className="aui-attachment-file bg-muted border-border h-14 max-w-40 justify-center rounded-xl border px-3">
    <AttachmentPrimitive.Name
      className="aui-attachment-name text-foreground text-xs"
      numberOfLines={1}
    />
  </View>
);

const ComposerAttachment: FC = () => {
  const uri = useAttachmentImageUri();

  return (
    <AttachmentPrimitive.Root className="aui-composer-attachment-root relative">
      {uri ? (
        <Image
          source={{ uri }}
          className="aui-composer-attachment-image bg-muted size-14 rounded-xl"
          resizeMode="cover"
        />
      ) : (
        <AttachmentName />
      )}
      <AttachmentPrimitive.Remove
        className="aui-composer-attachment-remove bg-foreground absolute -top-1.5 -right-1.5 size-5 items-center justify-center rounded-full"
        hitSlop={removeHitSlop}
        accessibilityLabel="Remove attachment"
      >
        <Icon as={XIcon} className="text-background size-3" />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

// Hit slop never extends past the parent view, so the badge grows into the 56dp
// thumbnail root instead of outward: the thumbnail has no tap of its own, and the
// top right of it removing the attachment is the price of a reachable target.
const removeHitSlop = { top: 0, right: 0, bottom: 34, left: 34 };

export const ComposerAttachments: FC = () => (
  <AuiIf condition={(s) => s.composer.attachments.length > 0}>
    <View className="aui-composer-attachments flex-row flex-wrap gap-2 px-1 pt-1">
      <ComposerPrimitive.Attachments>
        {() => <ComposerAttachment />}
      </ComposerPrimitive.Attachments>
    </View>
  </AuiIf>
);

/** 相册多选 → 逐个压缩成 jpeg 附件。＋ 菜单的「照片」走这里
 *  （压缩统一在 lib/attachments/image-compress：长边 ≤1600、按预算逐档退）。 */
export async function pickComposerImages(
  aui: ReturnType<typeof useAui>,
): Promise<void> {
  // 不再 catch 掉启动失败：调用方要把「相册打不开」这类错误显式提示出来，
  // 静默吞掉时用户看到的就是「点了没反应」。
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
  });
  if (result.canceled) return;

  let added = 0;
  let lastError: unknown = null;
  for (const asset of result.assets) {
    try {
      const compressed = await compressImage(asset);
      await aui.composer.addAttachment({
        name: `${(asset.fileName ?? "image").replace(/\.[^.]+$/, "")}.jpg`,
        contentType: "image/jpeg",
        type: "image",
        content: [
          {
            type: "image",
            image: `data:image/jpeg;base64,${compressed.base64}`,
          },
        ],
      });
      added += 1;
    } catch (err) {
      lastError = err;
    }
  }
  // 一张都没成 → 报第一个错；部分成功就静默（用户能看到已加进来的缩略图）
  if (added === 0) {
    throw lastError instanceof Error
      ? lastError
      : new Error("图片处理失败，请换一张试试");
  }
}

export const ComposerAddAttachment: FC = () => {
  const aui = useAui();

  const pickImages = async () => {
    await pickComposerImages(aui);
  };

  return (
    <ComposerPrimitive.AddAttachment
      onPress={pickImages}
      className="aui-composer-add-attachment active:bg-muted size-7 items-center justify-center rounded-full"
      hitSlop={iconButtonHitSlop}
      accessibilityLabel="Add image"
    >
      <Icon as={PlusIcon} className="text-muted-foreground size-4" />
    </ComposerPrimitive.AddAttachment>
  );
};

const UserMessageAttachment: FC = () => {
  const uri = useAttachmentImageUri();
  if (!uri) return <AttachmentName />;

  // 用户自己发的图也要能点开放大（与工具产出的图同款预览）：外面套 ImageZoom，
  // 缩略图保持 size-200 cover，点开进全屏 contain 预览
  return (
    <ImageZoom src={uri} alt="用户发送的图片">
      <Image
        source={{ uri }}
        className="aui-user-message-attachment-image bg-muted size-[200px] rounded-2xl"
        resizeMode="cover"
      />
    </ImageZoom>
  );
};

export const UserMessageAttachments: FC = () => (
  <AuiIf
    condition={(s) =>
      ((s.message.submission?.attachments ?? s.message.attachments)?.length ??
        0) > 0
    }
  >
    <View className="aui-user-message-attachments flex-row flex-wrap justify-end gap-1.5">
      <MessagePrimitive.Attachments>
        {() => <UserMessageAttachment />}
      </MessagePrimitive.Attachments>
    </View>
  </AuiIf>
);
