import { t } from "./i18n";
import {
  AttachmentTooLargeError,
  attachmentsFromDroppedFiles,
  fileAttachmentFromFile,
  fitImagesToSlots,
  IMAGE_MAX_BYTES,
  imageSentAsFile,
  isImageFile,
  TURN_IMAGE_MAX_BYTES,
  TURN_IMAGE_MAX_COUNT,
  type Attachment,
  type DroppedFile,
  type FileAttachment,
} from "./composer-attachments";

const MB = 1024 * 1024;
const ARCHIVE_NAME = /\.(?:zip|rar|7z|tar|gz|tgz|bz2|xz)$/i;

export function imageLimitNotice(leftOut: readonly string[]): string {
  return t(leftOut.length === 1 ? "composer.attach.imageLimit.one" : "composer.attach.imageLimit.many", {
    count: TURN_IMAGE_MAX_COUNT, mb: TURN_IMAGE_MAX_BYTES / MB, names: leftOut.join(", "),
  });
}

export function imagesAsFilesNotice(names: readonly string[]): string {
  return t(names.length === 1 ? "composer.attach.imageAsFile.one" : "composer.attach.imageAsFile.many", {
    mb: IMAGE_MAX_BYTES / MB, names: names.join(", "),
  });
}

/** The images that fit the slots and bytes left; the rest are named in one notice. */
export function imagesThatFit<T extends { name: string; size: number }>(images: readonly T[], slots: number, onNotice: (notice: string) => void, bytes = Infinity): T[] {
  const { kept, leftOut } = fitImagesToSlots(images, slots, bytes);
  if (leftOut.length) onNotice(imageLimitNotice(leftOut.map((image) => image.name)));
  return kept;
}

export function uploadFailure(name: string, err: unknown): string {
  if (err instanceof AttachmentTooLargeError) return t("composer.attach.tooLarge", { name: err.fileName, mb: err.maxBytes / MB });
  const message = err instanceof Error ? err.message : "upload failed";
  const said = message.includes(name) ? message : `${name}: ${message}`;
  return /[.!?]$/.test(said) ? said : `${said}.`;
}

export async function intakeFiles<T extends DroppedFile & { type: string }>(
  _files: readonly T[],
  _opts: {
    allowImages: boolean;
    getPath: (file: T) => string;
    uploadImage: (file: T) => Promise<Attachment | null>;
    /** "placed" when the uploader put its own tile in the draft; null when the file is not one it uploads. */
    uploadFile?: (file: T) => Promise<FileAttachment | "placed" | null>;
    /** Images the message can still take; the rest are left out and named in the notice. */
    imageSlots?: number;
    /** Image bytes the message can still take; images past it are left out the same way. */
    imageBytes?: number;
  },
): Promise<{ attachments: Attachment[]; notice: string | null }> {
  const { allowImages, getPath, uploadImage } = _opts;
  const asImage = (file: T) => allowImages && isImageFile(file) && !imageSentAsFile(file);
  const images = _files.filter(asImage);
  const overflow = new Set(fitImagesToSlots(images, _opts.imageSlots ?? Infinity, _opts.imageBytes).leftOut);
  const leftOut = [...overflow].map((file) => file.name);
  const files = _files.filter((file) => !overflow.has(file));
  const uploadFile = _opts.uploadFile ?? (async (file: T) => {
    if (!file.arrayBuffer) return null;
    return fileAttachmentFromFile(file as unknown as File);
  });
  const results = await Promise.all(files.map(async (file): Promise<{
    attachments: Attachment[];
    rejectedNames: string[];
    uploadError?: string;
    asFile?: string;
  }> => {
    if (asImage(file)) {
      try {
        const attachment = await uploadImage(file);
        return { attachments: attachment ? [attachment] : [], rejectedNames: [] };
      } catch (err) {
        return {
          attachments: [],
          rejectedNames: [],
          uploadError: uploadFailure(file.name, err),
        };
      }
    }
    const asFile = allowImages && imageSentAsFile(file) ? file.name : undefined;
    try {
      const attachment = await uploadFile(file);
      if (attachment === "placed") return { attachments: [], rejectedNames: [], asFile };
      if (attachment) {
        return { attachments: [attachment], rejectedNames: [], asFile };
      }
    } catch (err) {
      return {
        attachments: [],
        rejectedNames: [],
        uploadError: uploadFailure(file.name, err),
      };
    }
    const result = await attachmentsFromDroppedFiles([file], getPath);
    return result;
  }));
  const attachments = results.flatMap((result) => result.attachments);
  const rejectedNames = results.flatMap((result) => result.rejectedNames);
  const archives = rejectedNames.filter((name) => ARCHIVE_NAME.test(name));
  const unsupported = rejectedNames.filter((name) => !ARCHIVE_NAME.test(name));
  const uploadErrors = results.flatMap((result) => result.uploadError ? [result.uploadError] : []);
  const asFiles = results.flatMap((result) => result.asFile ? [result.asFile] : []);
  const notice = [
    leftOut.length ? imageLimitNotice(leftOut) : "",
    asFiles.length ? imagesAsFilesNotice(asFiles) : "",
    unsupported.length ? t("composer.attach.unsupported", { names: unsupported.join(", ") }) : "",
    archives.length ? t("composer.attach.archives", { names: archives.join(", ") }) : "",
    ...uploadErrors,
  ].filter(Boolean).join(" ") || null;
  return { attachments, notice };
}
