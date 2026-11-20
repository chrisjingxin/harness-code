/**
 * 输入框顶部图片缩略图条、用户消息图片条与全局放大预览灯箱。
 *
 * 1. `ComposerImagesBar`：按截图样式平铺在输入框最上方，顶部带圆角缩略图与右上角 `×` 关闭按钮，
 *    底部使用细分割线与文本输入区隔开；点击缩略图弹出放大预览。
 * 2. `MessageImagesBar`：在时间线用户消息气泡内回显已发送的缩略图，点击同样放大预览。
 * 3. `ImageLightbox`：Portal 全局居中预览弹窗，支持点击遮罩/`Esc` 关闭（关闭时恢复原焦点）
 *    及多张图片左右切换。
 */
import { IconChevronLeft, IconChevronRight, IconLoader2, IconPhoto, IconX } from "@tabler/icons-react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ReactElement } from "react"

import { formatImageByteSize, formatImageDimensions } from "./image-sizing.js"
import type { ConversationDraftImage } from "./types.js"

export interface ImagePreviewEntry {
  readonly id: string
  readonly name: string
  readonly width?: number
  readonly height?: number
  readonly sizeBytes: number
  readonly previewUrl?: string
}

function ImageLightbox({
  images,
  initialIndex,
  onResolvePreview,
  onClose,
}: {
  readonly images: readonly ImagePreviewEntry[]
  readonly initialIndex: number
  readonly onResolvePreview?: (imageId: string) => Promise<string | null>
  readonly onClose: () => void
}): ReactElement | null {
  const [index, setIndex] = useState(initialIndex)
  const [resolvedUrls, setResolvedUrls] = useState<Readonly<Record<string, string>>>({})
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set())
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )

  const restoreFocusAndClose = () => {
    const target = returnFocusRef.current
    onClose()
    if (target && target.isConnected) {
      queueMicrotask(() => target.focus())
    }
  }

  useEffect(() => {
    setIndex(Math.min(Math.max(0, initialIndex), Math.max(0, images.length - 1)))
  }, [initialIndex, images.length])

  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        restoreFocusAndClose()
        return
      }
      if (images.length > 1 && event.key === "ArrowLeft") {
        event.preventDefault()
        setIndex(current => (current - 1 + images.length) % images.length)
      } else if (images.length > 1 && event.key === "ArrowRight") {
        event.preventDefault()
        setIndex(current => (current + 1) % images.length)
      }
    }
    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [images.length, onClose])

  const current = images[index]
  useEffect(() => {
    if (!current || current.previewUrl || resolvedUrls[current.id] || failedIds.has(current.id) || !onResolvePreview) {
      return
    }
    let cancelled = false
    void onResolvePreview(current.id).then(url => {
      if (cancelled) return
      if (url) setResolvedUrls(prev => ({ ...prev, [current.id]: url }))
      else setFailedIds(prev => new Set(prev).add(current.id))
    }).catch(() => {
      if (!cancelled) setFailedIds(prev => new Set(prev).add(current.id))
    })
    return () => { cancelled = true }
  }, [current, resolvedUrls, failedIds, onResolvePreview])

  if (!current || typeof document === "undefined") return null

  const src = current.previewUrl ?? resolvedUrls[current.id]
  const failed = failedIds.has(current.id)
  const dims = formatImageDimensions(current.width, current.height)
  const metaParts = [current.name, dims, formatImageByteSize(current.sizeBytes)].filter(Boolean)

  return createPortal(
    <div
      className="wb-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览：${current.name}`}
      onClick={restoreFocusAndClose}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="wb-image-lightbox-close"
        aria-label="关闭图片预览"
        title="关闭 (Esc)"
        onClick={event => {
          event.stopPropagation()
          restoreFocusAndClose()
        }}
      >
        <IconX size={18} aria-hidden="true" />
      </button>

      {images.length > 1 ? (
        <button
          type="button"
          className="wb-image-lightbox-nav is-prev"
          aria-label="上一张图片"
          onClick={event => {
            event.stopPropagation()
            setIndex(curr => (curr - 1 + images.length) % images.length)
          }}
        >
          <IconChevronLeft size={22} aria-hidden="true" />
        </button>
      ) : null}

      <div className="wb-image-lightbox-stage" onClick={event => event.stopPropagation()}>
        {src ? (
          <img
            className="wb-image-lightbox-img"
            src={src}
            alt={current.name}
            onError={() => setFailedIds(prev => new Set(prev).add(current.id))}
          />
        ) : failed ? (
          <div className="wb-image-lightbox-fallback">
            <IconPhoto size={36} aria-hidden="true" />
            <span>原图缓存已清理或暂不可读</span>
          </div>
        ) : (
          <div className="wb-image-lightbox-fallback">
            <IconLoader2 size={28} className="wb-image-spin" aria-hidden="true" />
          </div>
        )}
        <div className="wb-image-lightbox-caption">
          <span>{metaParts.join(" · ")}</span>
          {images.length > 1 ? <span className="wb-image-lightbox-counter">{index + 1} / {images.length}</span> : null}
        </div>
      </div>

      {images.length > 1 ? (
        <button
          type="button"
          className="wb-image-lightbox-nav is-next"
          aria-label="下一张图片"
          onClick={event => {
            event.stopPropagation()
            setIndex(curr => (curr + 1) % images.length)
          }}
        >
          <IconChevronRight size={22} aria-hidden="true" />
        </button>
      ) : null}
    </div>,
    document.body,
  )
}

function ImageThumbnailContent({
  image,
  onResolvePreview,
  onResolvedUrl,
}: {
  readonly image: ImagePreviewEntry
  readonly onResolvePreview?: (imageId: string) => Promise<string | null>
  readonly onResolvedUrl?: (id: string, url: string) => void
}): ReactElement {
  const [url, setUrl] = useState<string | null>(image.previewUrl ?? null)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    setUrl(image.previewUrl ?? null)
    setBroken(false)
  }, [image.id, image.previewUrl])

  useEffect(() => {
    if (url || broken || !onResolvePreview || image.id.startsWith("preparing-")) return
    let cancelled = false
    void onResolvePreview(image.id).then(nextUrl => {
      if (cancelled) return
      if (nextUrl) {
        setUrl(nextUrl)
        onResolvedUrl?.(image.id, nextUrl)
      } else {
        setBroken(true)
      }
    }).catch(() => {
      if (!cancelled) setBroken(true)
    })
    return () => { cancelled = true }
  }, [url, broken, image.id, onResolvePreview])

  if (url && !broken) {
    return (
      <img
        src={url}
        alt={image.name}
        className="wb-image-thumb-img"
        onError={() => setBroken(true)}
      />
    )
  }
  return (
    <span className="wb-image-thumb-placeholder" aria-hidden="true">
      <IconPhoto size={18} />
    </span>
  )
}

/** 输入框最上方图片缩略图条（点击可放大，右上角 `×` 立即关闭移除）。 */
export function ComposerImagesBar({
  images,
  canEdit,
  onRemove,
  onResolvePreview,
}: {
  readonly images: readonly ConversationDraftImage[]
  readonly canEdit: boolean
  readonly onRemove: (image: ConversationDraftImage) => void
  readonly onResolvePreview?: (imageId: string) => Promise<string | null>
}): ReactElement | null {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [resolvedMap, setResolvedMap] = useState<Readonly<Record<string, string>>>({})

  useEffect(() => {
    if (images.length === 0) setPreviewIndex(null)
  }, [images.length])

  if (images.length === 0) return null

  const previewEntries: ImagePreviewEntry[] = images
    .filter(item => item.status !== "preparing")
    .map(item => ({
      id: item.id,
      name: item.name,
      width: item.width,
      height: item.height,
      sizeBytes: item.sizeBytes,
      previewUrl: item.previewUrl ?? resolvedMap[item.id],
    }))

  return (
    <>
      <div className="wb-composer-images" aria-label="待发送图片">
        {images.map((item, idx) => {
          const preparing = item.status === "preparing"
          const previewIdx = previewEntries.findIndex(entry => entry.id === item.id)
          const dims = formatImageDimensions(item.width, item.height)
          const title = [item.name, dims, formatImageByteSize(item.sizeBytes)].filter(Boolean).join(" · ")
          return (
            <div key={item.id} className="wb-composer-image-item" data-preparing={preparing || undefined}>
              <button
                type="button"
                className="wb-composer-image-thumb"
                aria-label={preparing ? `正在处理第 ${idx + 1} 张图片` : `预览第 ${idx + 1} 张图片：${item.name}`}
                title={title}
                disabled={preparing || previewIdx < 0}
                onClick={() => {
                  if (!preparing && previewIdx >= 0) setPreviewIndex(previewIdx)
                }}
              >
                <ImageThumbnailContent
                  image={{
                    id: item.id,
                    name: item.name,
                    width: item.width,
                    height: item.height,
                    sizeBytes: item.sizeBytes,
                    previewUrl: item.previewUrl ?? resolvedMap[item.id],
                  }}
                  onResolvePreview={onResolvePreview}
                  onResolvedUrl={(id, url) => setResolvedMap(prev => ({ ...prev, [id]: url }))}
                />
                {preparing ? (
                  <span className="wb-composer-image-loading" aria-hidden="true">
                    <IconLoader2 size={15} className="wb-image-spin" />
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="wb-composer-image-remove"
                aria-label={`移除第 ${idx + 1} 张图片`}
                title="移除图片"
                disabled={!canEdit}
                onClick={event => {
                  event.stopPropagation()
                  onRemove(item)
                }}
              >
                <IconX size={11} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      {previewIndex !== null && previewEntries.length > 0 ? (
        <ImageLightbox
          images={previewEntries}
          initialIndex={previewIndex}
          onResolvePreview={onResolvePreview}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}
    </>
  )
}

/** 用户消息气泡顶部的只读图片缩略图条（点击放大预览）。 */
export function MessageImagesBar({
  images,
  onResolvePreview,
}: {
  readonly images: readonly ImagePreviewEntry[]
  readonly onResolvePreview?: (imageId: string) => Promise<string | null>
}): ReactElement | null {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [resolvedMap, setResolvedMap] = useState<Readonly<Record<string, string>>>({})

  if (images.length === 0) return null

  const previewEntries = images.map(item => ({
    ...item,
    previewUrl: item.previewUrl ?? resolvedMap[item.id],
  }))

  return (
    <>
      <div className="wb-message-images" data-selection-ignore="true">
        {previewEntries.map((item, idx) => {
          const dims = formatImageDimensions(item.width, item.height)
          const title = [item.name, dims, formatImageByteSize(item.sizeBytes)].filter(Boolean).join(" · ")
          return (
            <button
              key={item.id}
              type="button"
              className="wb-message-image-thumb"
              aria-label={`预览图片：${item.name}`}
              title={title}
              onClick={() => setPreviewIndex(idx)}
            >
              <ImageThumbnailContent
                image={item}
                onResolvePreview={onResolvePreview}
                onResolvedUrl={(id, url) => setResolvedMap(prev => ({ ...prev, [id]: url }))}
              />
            </button>
          )
        })}
      </div>
      {previewIndex !== null ? (
        <ImageLightbox
          images={previewEntries}
          initialIndex={previewIndex}
          onResolvePreview={onResolvePreview}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}
    </>
  )
}
