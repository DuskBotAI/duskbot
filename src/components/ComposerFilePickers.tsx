// The composer's hidden file pickers. A phone or touch screen gets two more, so its + offers the photo library and the
// camera beside Files (an idea from Threebot, MIT); a desktop keeps the one picker.
import { useEffect, useRef, type InputHTMLAttributes, type RefObject } from "react";

import { nativeAttach, onAttachToComposer } from "@/lib/native-attach";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";

/** A phone-width window or a touch-first screen. */
export const TOUCH_ATTACH = `${PHONE_LAYOUT}, (hover: none) and (pointer: coarse)`;

export interface AttachChoices { photos: () => void; camera: () => void }

export function useComposerFilePickers(onPick: (files: ArrayLike<File> | null) => void) {
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => onAttachToComposer((files) => pick.current(files)), []);
  const native = nativeAttach();
  const files = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const touch = useMediaQuery(TOUCH_ATTACH);
  const picker = (ref: RefObject<HTMLInputElement | null>, props: InputHTMLAttributes<HTMLInputElement>) => (
    <input
      ref={ref}
      type="file"
      className="hidden"
      onChange={(event) => {
        onPick(event.target.files);
        // reset so picking the same file again still fires onChange
        event.target.value = "";
      }}
      {...props}
    />
  );
  return {
    inputs: <>
      {picker(files, { multiple: true })}
      {touch && picker(photos, { multiple: true, accept: "image/*,video/*", "data-picker": "photos" } as InputHTMLAttributes<HTMLInputElement>)}
      {touch && picker(camera, { accept: "image/*", capture: "environment", "data-picker": "camera" } as InputHTMLAttributes<HTMLInputElement>)}
    </>,
    files: native ? () => void native.files().then(onPick, () => {}) : () => files.current?.click(),
    choices: touch ? {
      photos: native ? () => void native.photos().then(onPick, () => {}) : () => photos.current?.click(),
      camera: native?.camera ? () => void native.camera!().then(onPick, () => {}) : () => camera.current?.click(),
    } satisfies AttachChoices : undefined,
  };
}
