import AVFoundation
import Photos
import PhotosUI
import UIKit
import UniformTypeIdentifiers

struct MediaPickerLabels {
    let allPhotos: String
    let addPhotoOne: String
    let addPhotosCount: String
    let addItemOne: String
    let addItemsCount: String
    let back: String
    let takePhoto: String
    let moreOptions: String
    let switchCamera: String
    let flash: String
    let flashAuto: String
    let flashOn: String
    let flashOff: String
    let photoLibrary: String
    let cameraOffTitle: String
    let cameraOffBody: String
    let cameraUnavailable: String
    let photosOffTitle: String
    let photosOffBody: String
    let openSettings: String

    init(_ raw: [String: Any]? = nil) {
        allPhotos = raw?["allPhotos"] as? String ?? "All Photos"
        addPhotoOne = raw?["addPhotoOne"] as? String ?? "Add 1 photo"
        addPhotosCount = raw?["addPhotosCount"] as? String ?? "Add {count} photos"
        addItemOne = raw?["addItemOne"] as? String ?? "Add 1 item"
        addItemsCount = raw?["addItemsCount"] as? String ?? "Add {count} items"
        back = raw?["back"] as? String ?? "Back"
        takePhoto = raw?["takePhoto"] as? String ?? "Take photo"
        moreOptions = raw?["moreOptions"] as? String ?? "Camera options"
        switchCamera = raw?["switchCamera"] as? String ?? "Switch camera"
        flash = raw?["flash"] as? String ?? "Flash"
        flashAuto = raw?["flashAuto"] as? String ?? "Auto"
        flashOn = raw?["flashOn"] as? String ?? "On"
        flashOff = raw?["flashOff"] as? String ?? "Off"
        photoLibrary = raw?["photoLibrary"] as? String ?? "Photo library"
        cameraOffTitle = raw?["cameraOffTitle"] as? String ?? "The camera is off"
        cameraOffBody = raw?["cameraOffBody"] as? String ?? "Allow camera access in Settings to take a photo."
        cameraUnavailable = raw?["cameraUnavailable"] as? String ?? "Camera isn't available on this device."
        photosOffTitle = raw?["photosOffTitle"] as? String ?? "Photo access is off"
        photosOffBody = raw?["photosOffBody"] as? String ?? "Allow access in Settings, or use All Photos to pick from your library."
        openSettings = raw?["openSettings"] as? String ?? "Open settings"
    }

    func addTitle(count: Int, hasVideo: Bool) -> String {
        if hasVideo {
            return count == 1 ? addItemOne : addItemsCount.replacingOccurrences(of: "{count}", with: "\(count)")
        }
        return count == 1 ? addPhotoOne : addPhotosCount.replacingOccurrences(of: "{count}", with: "\(count)")
    }
}

final class MediaPickerLibraryCache: NSObject, PHPhotoLibraryChangeObserver {
    static let shared = MediaPickerLibraryCache()
    static let didUpdateNotification = Notification.Name("bot.dusk.mobile.mediaPickerLibraryUpdated")

    let imageManager = PHCachingImageManager()
    private let queue = DispatchQueue(label: "bot.dusk.mobile.media-picker-photos", qos: .userInitiated)
    private let lock = NSLock()
    private var cachedResult: PHFetchResult<PHAsset>?
    private var observing = false
    private var loading = false
    private var waiters: [(PHFetchResult<PHAsset>) -> Void] = []

    var currentResult: PHFetchResult<PHAsset>? {
        lock.lock()
        defer { lock.unlock() }
        return cachedResult
    }

    func warmIfAuthorized(thumbnailPixelSize: CGSize = CGSize(width: 390, height: 390)) {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return }
        fetch(thumbnailPixelSize: thumbnailPixelSize) { _ in }
    }

    func fetch(thumbnailPixelSize: CGSize, completion: @escaping (PHFetchResult<PHAsset>) -> Void) {
        lock.lock()
        if let cached = cachedResult {
            lock.unlock()
            completion(cached)
            return
        }
        waiters.append(completion)
        if loading {
            lock.unlock()
            return
        }
        loading = true
        lock.unlock()

        queue.async { [weak self] in
            guard let self else { return }
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.predicate = NSPredicate(
                format: "mediaType == %d OR mediaType == %d",
                PHAssetMediaType.image.rawValue,
                PHAssetMediaType.video.rawValue
            )
            let result = PHAsset.fetchAssets(with: options)
            let warmCount = min(result.count, 18)
            if warmCount > 0 {
                var assets: [PHAsset] = []
                assets.reserveCapacity(warmCount)
                for idx in 0..<warmCount { assets.append(result.object(at: idx)) }
                let reqOptions = PHImageRequestOptions()
                reqOptions.deliveryMode = .opportunistic
                reqOptions.resizeMode = .fast
                reqOptions.isNetworkAccessAllowed = true
                self.imageManager.startCachingImages(for: assets, targetSize: thumbnailPixelSize, contentMode: .aspectFill, options: reqOptions)
            }

            self.lock.lock()
            self.cachedResult = result
            self.loading = false
            let shouldRegister = !self.observing
            self.observing = true
            let pending = self.waiters
            self.waiters.removeAll()
            self.lock.unlock()

            if shouldRegister {
                PHPhotoLibrary.shared().register(self)
            }
            DispatchQueue.main.async {
                for callback in pending { callback(result) }
            }
        }
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        lock.lock()
        let current = cachedResult
        lock.unlock()
        guard let current, let details = changeInstance.changeDetails(for: current) else { return }
        let updated = details.fetchResultAfterChanges
        lock.lock()
        cachedResult = updated
        lock.unlock()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.didUpdateNotification, object: updated)
        }
    }
}

struct MediaPickerMorphContext {
    let origin: ComposerMorphOrigin
    let resolveDismissRect: () -> CGRect
    let onRelease: (@escaping () -> Void) -> Void
}

/// Floating bottom media sheet for the composer's + menu: morphs smoothly out of the prompt bar into a multi-select
/// 3-column recent photo library grid or a full-bleed live camera viewfinder inside the same rounded card.
final class MediaPickerSheetViewController: UIViewController {
    enum Mode {
        case photos
        case camera
    }

    private enum MorphState {
        case collapsed
        case expanding
        case expanded
        case dismissing
    }

    private let allowMultiple: Bool
    private let maxSelection: Int
    private let labels: MediaPickerLabels
    private let morphContext: MediaPickerMorphContext?
    private let onComplete: ([[String: Any]]) -> Void

    private var mode: Mode
    private var canReturnToPhotos: Bool
    private var finished = false
    private var animatingPresentation = false
    private var exportingSelection = false
    private var morphState: MorphState = .collapsed
    private var releasedSource = false

    private let scrimView = UIView()
    private let cardShadowView = UIView()
    private let cardView = UIView()
    private let morphGlassView: UIVisualEffectView = {
        if #available(iOS 26.0, *) {
            return UIVisualEffectView(effect: UIGlassEffect(style: .regular))
        }
        return UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
    }()
    private let cardFillView = UIView()
    private let contentContainer = UIView()
    private let sourceMorphContainer = UIView()
    private let rimView = UIView()

    private var cardLeadingConstraint: NSLayoutConstraint!
    private var cardTrailingConstraint: NSLayoutConstraint!
    private var cardHeightConstraint: NSLayoutConstraint!
    private var cardBottomConstraint: NSLayoutConstraint!
    private var contentWidthConstraint: NSLayoutConstraint!
    private var contentHeightConstraint: NSLayoutConstraint!
    private var sourceWidthConstraint: NSLayoutConstraint!
    private var sourceHeightConstraint: NSLayoutConstraint!

    private var collectionView: UICollectionView!
    private let photosFallbackView = EmptyNoticeView()
    private let cameraContainer = UIView()
    private let cameraPreviewView = CameraPreviewView()
    private let cameraFallbackView = EmptyNoticeView()
    private let shutterFlashView = UIView()
    private let focusRingView = UIView()

    private let backButton = MediaPickerSheetViewController.makeGlassCircleButton(symbol: "chevron.left", pointSize: 18, weight: .semibold)
    private let allPhotosButton = MediaPickerSheetViewController.makeGlassPillButton()
    private let addPhotosButton = MediaPickerSheetViewController.makeAddPillButton()
    private let addSpinner = UIActivityIndicatorView(style: .medium)
    private let shutterButton = ShutterButton()
    private let moreButton = MediaPickerSheetViewController.makeGlassCircleButton(symbol: "ellipsis", pointSize: 18, weight: .semibold)
    private let moreBadgeDot = UIView()

    private var panGesture: UIPanGestureRecognizer!
    private var isDraggingSheet = false
    private var dragStartOffset: CGFloat = 0

    private let sessionQueue = DispatchQueue(label: "bot.dusk.mobile.media-picker-camera")
    private let captureSession = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private var videoInput: AVCaptureDeviceInput?
    private var cameraPosition: AVCaptureDevice.Position = .back
    private var flashMode: AVCaptureDevice.FlashMode = .auto
    private var sessionConfigured = false
    private var cameraAvailable = false
    private var hasMultipleCamerasCached = false
    private var hasFlashCached = false
    private var isCapturing = false
    private var pinchStartZoom: CGFloat = 1

    private var imageManager: PHCachingImageManager { MediaPickerLibraryCache.shared.imageManager }
    private var fetchResult: PHFetchResult<PHAsset>?
    private var selectedAssetIds: [String] = []
    private var libraryObserver: NSObjectProtocol?
    private var thumbnailPixelSize: CGSize = CGSize(width: 390, height: 390)

    private let lightHaptic = UIImpactFeedbackGenerator(style: .light)
    private let mediumHaptic = UIImpactFeedbackGenerator(style: .medium)
    private let selectionHaptic = UISelectionFeedbackGenerator()
    private let noticeHaptic = UINotificationFeedbackGenerator()

    private static let cardInset: CGFloat = 10
    private static let gridSpacing: CGFloat = 2
    private static let bottomControlCenterOffset: CGFloat = 44

    init(mode: Mode, multiple: Bool, labels: MediaPickerLabels, morph: MediaPickerMorphContext? = nil, onComplete: @escaping ([[String: Any]]) -> Void) {
        self.mode = mode
        self.canReturnToPhotos = false
        self.allowMultiple = multiple
        self.maxSelection = multiple ? 10 : 1
        self.labels = labels
        self.morphContext = morph
        self.onComplete = onComplete
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalPresentationCapturesStatusBarAppearance = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        if let libraryObserver { NotificationCenter.default.removeObserver(libraryObserver) }
        if !releasedSource, let release = morphContext?.onRelease {
            DispatchQueue.main.async { release {} }
        }
        let session = captureSession
        sessionQueue.async {
            if session.isRunning { session.stopRunning() }
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.accessibilityViewIsModal = true

        setupScrim()
        setupCard()
        setupPhotoGrid()
        setupCameraView()
        setupFloatingControls()
        setupGestures()

        applyModeUI(animated: false)
        prepareCollapsedAppearance()
        lightHaptic.prepare()
        mediumHaptic.prepare()
        selectionHaptic.prepare()

        if mode == .photos {
            preparePhotosMode()
        } else {
            prepareCameraMode()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !animatingPresentation else { return }
        animatingPresentation = true
        presentCard()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let boundsWidth = view.bounds.width
        let targetWidth = max(1, boundsWidth - Self.cardInset * 2)
        let targetHeight = desiredCardHeight()
        if abs(contentWidthConstraint.constant - targetWidth) > 0.5 {
            contentWidthConstraint.constant = targetWidth
        }
        if abs(contentHeightConstraint.constant - targetHeight) > 0.5 {
            contentHeightConstraint.constant = targetHeight
        }
        let cellSide = max(80, (targetWidth - Self.gridSpacing * 2) / 3)
        let scale = max(traitCollection.displayScale, 2)
        thumbnailPixelSize = CGSize(width: ceil(cellSide * scale), height: ceil(cellSide * scale))

        switch morphState {
        case .collapsed:
            applyRectConstraints(resolvedSourceRect())
            let radius = resolvedSourceRadius()
            cardView.layer.cornerRadius = radius
            rimView.layer.cornerRadius = radius
        case .expanded:
            applyExpandedConstraints()
            let radius = expandedCornerRadius()
            if cardView.layer.cornerRadius != radius {
                cardView.layer.cornerRadius = radius
                rimView.layer.cornerRadius = radius
            }
            cardShadowView.layer.shadowPath = UIBezierPath(roundedRect: cardShadowView.bounds, cornerRadius: radius).cgPath
        case .expanding, .dismissing:
            break
        }
    }

    private func desiredCardHeight() -> CGFloat {
        let boundsHeight = view.bounds.height
        guard boundsHeight > 0 else { return 520 }
        let maxHeight = boundsHeight - view.safeAreaInsets.top - 72
        return min(maxHeight, max(360, round(boundsHeight * 0.625)))
    }

    private func expandedCornerRadius() -> CGFloat {
        view.safeAreaInsets.bottom > 0 ? 44 : 28
    }

    private func fallbackSourceRect() -> CGRect {
        let boundsWidth = view.bounds.width > 0 ? view.bounds.width : 390
        let boundsHeight = view.bounds.height > 0 ? view.bounds.height : 844
        let inset: CGFloat = 16
        let height: CGFloat = 48
        let bottomGap = view.safeAreaInsets.bottom + 8
        return CGRect(x: inset, y: boundsHeight - bottomGap - height, width: max(120, boundsWidth - inset * 2), height: height)
    }

    private func resolvedSourceRect() -> CGRect {
        if let rect = morphContext?.origin.rect, rect.width >= 40, rect.height >= 24 {
            return rect
        }
        return fallbackSourceRect()
    }

    private func resolvedDismissRect() -> CGRect {
        if let rect = morphContext?.resolveDismissRect(), rect.width >= 40, rect.height >= 24 {
            return rect
        }
        return fallbackSourceRect()
    }

    private func resolvedSourceRadius() -> CGFloat {
        if let r = morphContext?.origin.cornerRadius, r > 0 { return r }
        return min(24, resolvedSourceRect().height / 2)
    }

    private func applyRectConstraints(_ rect: CGRect) {
        let boundsWidth = max(1, view.bounds.width)
        let boundsHeight = max(1, view.bounds.height)
        cardLeadingConstraint.constant = rect.minX
        cardTrailingConstraint.constant = rect.maxX - boundsWidth
        cardBottomConstraint.constant = rect.maxY - boundsHeight
        cardHeightConstraint.constant = rect.height
    }

    private func applyExpandedConstraints() {
        cardLeadingConstraint.constant = Self.cardInset
        cardTrailingConstraint.constant = -Self.cardInset
        cardBottomConstraint.constant = -Self.cardInset
        cardHeightConstraint.constant = desiredCardHeight()
    }

    private func setupScrim() {
        scrimView.backgroundColor = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor.black.withAlphaComponent(0.48)
                : UIColor.black.withAlphaComponent(0.32)
        }
        scrimView.alpha = 0
        scrimView.translatesAutoresizingMaskIntoConstraints = false
        scrimView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(scrimTapped)))
        view.addSubview(scrimView)
        NSLayoutConstraint.activate([
            scrimView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrimView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrimView.topAnchor.constraint(equalTo: view.topAnchor),
            scrimView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    private func setupCard() {
        cardShadowView.translatesAutoresizingMaskIntoConstraints = false
        cardShadowView.layer.shadowColor = UIColor.black.cgColor
        cardShadowView.layer.shadowOpacity = 0
        cardShadowView.layer.shadowRadius = 24
        cardShadowView.layer.shadowOffset = CGSize(width: 0, height: 8)
        view.addSubview(cardShadowView)

        cardView.translatesAutoresizingMaskIntoConstraints = false
        cardView.backgroundColor = .clear
        cardView.layer.cornerCurve = .continuous
        cardView.layer.cornerRadius = resolvedSourceRadius()
        cardView.clipsToBounds = true
        cardShadowView.addSubview(cardView)

        morphGlassView.translatesAutoresizingMaskIntoConstraints = false
        morphGlassView.isUserInteractionEnabled = false
        if let style = morphContext?.origin.userInterfaceStyle, style != .unspecified {
            morphGlassView.overrideUserInterfaceStyle = style
        }
        cardView.addSubview(morphGlassView)

        cardFillView.translatesAutoresizingMaskIntoConstraints = false
        cardFillView.backgroundColor = UIColor(white: 0.06, alpha: 1)
        cardFillView.isUserInteractionEnabled = false
        cardView.addSubview(cardFillView)

        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        contentContainer.backgroundColor = .clear
        contentContainer.overrideUserInterfaceStyle = .dark
        cardView.addSubview(contentContainer)

        sourceMorphContainer.translatesAutoresizingMaskIntoConstraints = false
        sourceMorphContainer.isUserInteractionEnabled = false
        sourceMorphContainer.clipsToBounds = true
        if let snapshot = morphContext?.origin.snapshot {
            snapshot.translatesAutoresizingMaskIntoConstraints = false
            snapshot.isUserInteractionEnabled = false
            sourceMorphContainer.addSubview(snapshot)
            NSLayoutConstraint.activate([
                snapshot.leadingAnchor.constraint(equalTo: sourceMorphContainer.leadingAnchor),
                snapshot.trailingAnchor.constraint(equalTo: sourceMorphContainer.trailingAnchor),
                snapshot.topAnchor.constraint(equalTo: sourceMorphContainer.topAnchor),
                snapshot.bottomAnchor.constraint(equalTo: sourceMorphContainer.bottomAnchor),
            ])
        }
        cardView.addSubview(sourceMorphContainer)

        rimView.translatesAutoresizingMaskIntoConstraints = false
        rimView.isUserInteractionEnabled = false
        rimView.layer.cornerCurve = .continuous
        rimView.layer.cornerRadius = resolvedSourceRadius()
        rimView.layer.borderWidth = 0.5
        rimView.layer.borderColor = UIColor.white.withAlphaComponent(0.14).cgColor

        let initialRect = resolvedSourceRect()
        let targetWidth = max(1, (view.bounds.width > 0 ? view.bounds.width : 390) - Self.cardInset * 2)
        cardLeadingConstraint = cardShadowView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: initialRect.minX)
        cardTrailingConstraint = cardShadowView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Self.cardInset)
        cardHeightConstraint = cardShadowView.heightAnchor.constraint(equalToConstant: initialRect.height)
        cardBottomConstraint = cardShadowView.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -Self.cardInset)
        contentWidthConstraint = contentContainer.widthAnchor.constraint(equalToConstant: targetWidth)
        contentHeightConstraint = contentContainer.heightAnchor.constraint(equalToConstant: desiredCardHeight())
        sourceWidthConstraint = sourceMorphContainer.widthAnchor.constraint(equalToConstant: initialRect.width)
        sourceHeightConstraint = sourceMorphContainer.heightAnchor.constraint(equalToConstant: initialRect.height)

        NSLayoutConstraint.activate([
            cardLeadingConstraint,
            cardTrailingConstraint,
            cardBottomConstraint,
            cardHeightConstraint,

            cardView.leadingAnchor.constraint(equalTo: cardShadowView.leadingAnchor),
            cardView.trailingAnchor.constraint(equalTo: cardShadowView.trailingAnchor),
            cardView.topAnchor.constraint(equalTo: cardShadowView.topAnchor),
            cardView.bottomAnchor.constraint(equalTo: cardShadowView.bottomAnchor),

            morphGlassView.leadingAnchor.constraint(equalTo: cardView.leadingAnchor),
            morphGlassView.trailingAnchor.constraint(equalTo: cardView.trailingAnchor),
            morphGlassView.topAnchor.constraint(equalTo: cardView.topAnchor),
            morphGlassView.bottomAnchor.constraint(equalTo: cardView.bottomAnchor),

            cardFillView.leadingAnchor.constraint(equalTo: cardView.leadingAnchor),
            cardFillView.trailingAnchor.constraint(equalTo: cardView.trailingAnchor),
            cardFillView.topAnchor.constraint(equalTo: cardView.topAnchor),
            cardFillView.bottomAnchor.constraint(equalTo: cardView.bottomAnchor),

            contentContainer.centerXAnchor.constraint(equalTo: cardView.centerXAnchor),
            contentContainer.topAnchor.constraint(equalTo: cardView.topAnchor),
            contentWidthConstraint,
            contentHeightConstraint,

            sourceMorphContainer.centerXAnchor.constraint(equalTo: cardView.centerXAnchor),
            sourceMorphContainer.bottomAnchor.constraint(equalTo: cardView.bottomAnchor),
            sourceWidthConstraint,
            sourceHeightConstraint,
        ])
    }

    private func setupPhotoGrid() {
        let itemSize = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1.0 / 3.0), heightDimension: .fractionalHeight(1.0))
        let item = NSCollectionLayoutItem(layoutSize: itemSize)
        let groupSize = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1.0), heightDimension: .fractionalWidth(1.0 / 3.0))
        let group = NSCollectionLayoutGroup.horizontal(layoutSize: groupSize, repeatingSubitem: item, count: 3)
        group.interItemSpacing = .fixed(Self.gridSpacing)
        let section = NSCollectionLayoutSection(group: group)
        section.interGroupSpacing = Self.gridSpacing
        let layout = UICollectionViewCompositionalLayout(section: section)

        collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        collectionView.backgroundColor = .clear
        collectionView.alwaysBounceVertical = true
        collectionView.showsVerticalScrollIndicator = false
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.contentInset = UIEdgeInsets(top: 0, left: 0, bottom: 92, right: 0)
        collectionView.dataSource = self
        collectionView.delegate = self
        collectionView.register(PhotoTileCell.self, forCellWithReuseIdentifier: PhotoTileCell.reuseId)
        contentContainer.addSubview(collectionView)

        photosFallbackView.translatesAutoresizingMaskIntoConstraints = false
        photosFallbackView.isHidden = true
        contentContainer.addSubview(photosFallbackView)

        NSLayoutConstraint.activate([
            collectionView.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),
            collectionView.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            collectionView.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),

            photosFallbackView.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor, constant: 28),
            photosFallbackView.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor, constant: -28),
            photosFallbackView.centerYAnchor.constraint(equalTo: contentContainer.centerYAnchor, constant: -20),
        ])
    }

    private func setupCameraView() {
        cameraContainer.translatesAutoresizingMaskIntoConstraints = false
        cameraContainer.backgroundColor = .clear
        cameraContainer.clipsToBounds = true
        contentContainer.addSubview(cameraContainer)

        cameraPreviewView.previewLayer.session = captureSession
        cameraPreviewView.previewLayer.videoGravity = .resizeAspectFill
        cameraPreviewView.backgroundColor = .clear
        cameraPreviewView.translatesAutoresizingMaskIntoConstraints = false
        cameraContainer.addSubview(cameraPreviewView)

        cameraFallbackView.translatesAutoresizingMaskIntoConstraints = false
        cameraFallbackView.isHidden = true
        cameraContainer.addSubview(cameraFallbackView)

        shutterFlashView.translatesAutoresizingMaskIntoConstraints = false
        shutterFlashView.backgroundColor = .white
        shutterFlashView.alpha = 0
        shutterFlashView.isUserInteractionEnabled = false
        cameraContainer.addSubview(shutterFlashView)

        focusRingView.frame = CGRect(x: 0, y: 0, width: 64, height: 64)
        focusRingView.layer.cornerRadius = 32
        focusRingView.layer.borderWidth = 1.5
        focusRingView.layer.borderColor = UIColor.white.withAlphaComponent(0.9).cgColor
        focusRingView.alpha = 0
        focusRingView.isUserInteractionEnabled = false
        cameraContainer.addSubview(focusRingView)

        let focusTap = UITapGestureRecognizer(target: self, action: #selector(cameraTapped(_:)))
        cameraContainer.addGestureRecognizer(focusTap)
        let zoomPinch = UIPinchGestureRecognizer(target: self, action: #selector(cameraPinched(_:)))
        cameraContainer.addGestureRecognizer(zoomPinch)

        NSLayoutConstraint.activate([
            cameraContainer.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            cameraContainer.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),
            cameraContainer.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            cameraContainer.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),

            cameraPreviewView.leadingAnchor.constraint(equalTo: cameraContainer.leadingAnchor),
            cameraPreviewView.trailingAnchor.constraint(equalTo: cameraContainer.trailingAnchor),
            cameraPreviewView.topAnchor.constraint(equalTo: cameraContainer.topAnchor),
            cameraPreviewView.bottomAnchor.constraint(equalTo: cameraContainer.bottomAnchor),

            cameraFallbackView.leadingAnchor.constraint(equalTo: cameraContainer.leadingAnchor, constant: 28),
            cameraFallbackView.trailingAnchor.constraint(equalTo: cameraContainer.trailingAnchor, constant: -28),
            cameraFallbackView.centerYAnchor.constraint(equalTo: cameraContainer.centerYAnchor, constant: -20),

            shutterFlashView.leadingAnchor.constraint(equalTo: cameraContainer.leadingAnchor),
            shutterFlashView.trailingAnchor.constraint(equalTo: cameraContainer.trailingAnchor),
            shutterFlashView.topAnchor.constraint(equalTo: cameraContainer.topAnchor),
            shutterFlashView.bottomAnchor.constraint(equalTo: cameraContainer.bottomAnchor),
        ])
    }

    private func setupFloatingControls() {
        backButton.translatesAutoresizingMaskIntoConstraints = false
        backButton.accessibilityLabel = labels.back
        backButton.addAction(UIAction { [weak self] _ in self?.backTapped() }, for: .touchUpInside)

        allPhotosButton.translatesAutoresizingMaskIntoConstraints = false
        var titleAttr = AttributedString(labels.allPhotos)
        titleAttr.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
        allPhotosButton.configuration?.attributedTitle = titleAttr
        allPhotosButton.accessibilityLabel = labels.allPhotos
        allPhotosButton.addAction(UIAction { [weak self] _ in self?.openSystemPhotoPicker() }, for: .touchUpInside)

        addPhotosButton.translatesAutoresizingMaskIntoConstraints = false
        addPhotosButton.alpha = 0
        addPhotosButton.isHidden = true
        addPhotosButton.addAction(UIAction { [weak self] _ in self?.exportSelectedAssets() }, for: .touchUpInside)

        addSpinner.translatesAutoresizingMaskIntoConstraints = false
        addSpinner.color = .black
        addSpinner.hidesWhenStopped = true
        addPhotosButton.addSubview(addSpinner)

        shutterButton.translatesAutoresizingMaskIntoConstraints = false
        shutterButton.accessibilityLabel = labels.takePhoto
        shutterButton.addTarget(self, action: #selector(shutterTapped), for: .touchUpInside)

        moreButton.translatesAutoresizingMaskIntoConstraints = false
        moreButton.accessibilityLabel = labels.moreOptions
        moreButton.showsMenuAsPrimaryAction = true
        rebuildMoreMenu()

        moreBadgeDot.translatesAutoresizingMaskIntoConstraints = false
        moreBadgeDot.backgroundColor = .systemBlue
        moreBadgeDot.layer.cornerRadius = 4.5
        moreBadgeDot.layer.borderWidth = 1.5
        moreBadgeDot.layer.borderColor = UIColor.black.withAlphaComponent(0.75).cgColor
        moreBadgeDot.isUserInteractionEnabled = false

        // Sibling above moreButton so iOS 26 glass button subviews never cover or clip the badge.
        [backButton, allPhotosButton, addPhotosButton, shutterButton, moreButton, moreBadgeDot, rimView].forEach(cardView.addSubview)

        let controlCenterY = cardView.bottomAnchor
        NSLayoutConstraint.activate([
            backButton.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 20),
            backButton.widthAnchor.constraint(equalToConstant: 46),
            backButton.heightAnchor.constraint(equalToConstant: 46),
            backButton.centerYAnchor.constraint(equalTo: controlCenterY, constant: -Self.bottomControlCenterOffset),

            allPhotosButton.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -20),
            allPhotosButton.heightAnchor.constraint(equalToConstant: 46),
            allPhotosButton.centerYAnchor.constraint(equalTo: controlCenterY, constant: -Self.bottomControlCenterOffset),

            addPhotosButton.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -20),
            addPhotosButton.heightAnchor.constraint(equalToConstant: 48),
            addPhotosButton.centerYAnchor.constraint(equalTo: controlCenterY, constant: -Self.bottomControlCenterOffset),

            addSpinner.centerXAnchor.constraint(equalTo: addPhotosButton.centerXAnchor),
            addSpinner.centerYAnchor.constraint(equalTo: addPhotosButton.centerYAnchor),

            shutterButton.centerXAnchor.constraint(equalTo: cardView.centerXAnchor),
            shutterButton.widthAnchor.constraint(equalToConstant: 66),
            shutterButton.heightAnchor.constraint(equalToConstant: 66),
            shutterButton.centerYAnchor.constraint(equalTo: controlCenterY, constant: -Self.bottomControlCenterOffset),

            moreButton.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -20),
            moreButton.widthAnchor.constraint(equalToConstant: 46),
            moreButton.heightAnchor.constraint(equalToConstant: 46),
            moreButton.centerYAnchor.constraint(equalTo: controlCenterY, constant: -Self.bottomControlCenterOffset),

            moreBadgeDot.widthAnchor.constraint(equalToConstant: 9),
            moreBadgeDot.heightAnchor.constraint(equalToConstant: 9),
            moreBadgeDot.topAnchor.constraint(equalTo: moreButton.topAnchor, constant: 1),
            moreBadgeDot.trailingAnchor.constraint(equalTo: moreButton.trailingAnchor, constant: -1),

            rimView.leadingAnchor.constraint(equalTo: cardView.leadingAnchor),
            rimView.trailingAnchor.constraint(equalTo: cardView.trailingAnchor),
            rimView.topAnchor.constraint(equalTo: cardView.topAnchor),
            rimView.bottomAnchor.constraint(equalTo: cardView.bottomAnchor),
        ])
    }

    private func setupGestures() {
        panGesture = UIPanGestureRecognizer(target: self, action: #selector(handleSheetPan(_:)))
        panGesture.delegate = self
        cardView.addGestureRecognizer(panGesture)
    }

    private static func makeGlassCircleButton(symbol: String, pointSize: CGFloat, weight: UIImage.SymbolWeight) -> UIButton {
        var config = glassButtonConfiguration()
        config.contentInsets = .zero
        config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight))
        let button = UIButton(configuration: config)
        button.overrideUserInterfaceStyle = .dark
        return button
    }

    private static func makeGlassPillButton() -> UIButton {
        var config = glassButtonConfiguration()
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20)
        let button = UIButton(configuration: config)
        button.overrideUserInterfaceStyle = .dark
        return button
    }

    private static func makeAddPillButton() -> UIButton {
        var config = UIButton.Configuration.filled()
        config.cornerStyle = .capsule
        config.baseBackgroundColor = .white
        config.baseForegroundColor = .black
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 22, bottom: 0, trailing: 22)
        let button = UIButton(configuration: config)
        button.layer.shadowColor = UIColor.black.cgColor
        button.layer.shadowOpacity = 0.28
        button.layer.shadowRadius = 14
        button.layer.shadowOffset = CGSize(width: 0, height: 4)
        return button
    }

    private static func glassButtonConfiguration() -> UIButton.Configuration {
        var config: UIButton.Configuration
        if #available(iOS 26.0, *) {
            config = .glass()
            let effect = UIGlassEffect(style: .regular)
            effect.isInteractive = true
            effect.tintColor = UIColor(white: 0.06, alpha: 0.52)
            config.background.visualEffect = effect
        } else {
            config = .plain()
            config.background.visualEffect = UIBlurEffect(style: .systemChromeMaterialDark)
            config.background.backgroundColor = UIColor(white: 0.08, alpha: 0.45)
            config.background.strokeColor = UIColor.white.withAlphaComponent(0.16)
            config.background.strokeWidth = 0.5
        }
        config.cornerStyle = .capsule
        config.baseForegroundColor = .white
        return config
    }

    private func activeFloatingControls() -> [UIView] {
        var controls: [UIView] = [backButton]
        if mode == .camera {
            controls.append(contentsOf: [shutterButton, moreButton])
            if !moreBadgeDot.isHidden { controls.append(moreBadgeDot) }
        } else if selectedAssetIds.isEmpty {
            controls.append(allPhotosButton)
        } else {
            controls.append(addPhotosButton)
        }
        return controls
    }

    private func prepareCollapsedAppearance() {
        let reduced = UIAccessibility.isReduceMotionEnabled
        if reduced {
            morphState = .expanded
            cardShadowView.alpha = 0
            cardShadowView.layer.shadowOpacity = 0.42
            cardFillView.alpha = 1
            rimView.alpha = 1
            morphGlassView.alpha = 0
            sourceMorphContainer.isHidden = true
            contentContainer.alpha = 1
            contentContainer.transform = .identity
            return
        }
        let hasSnapshot = morphContext?.origin.snapshot != nil
        cardShadowView.alpha = 1
        cardShadowView.layer.shadowOpacity = 0
        cardShadowView.layer.shadowPath = nil
        cardFillView.alpha = 0
        rimView.alpha = 0
        morphGlassView.alpha = hasSnapshot ? 0 : 1
        sourceMorphContainer.isHidden = !hasSnapshot
        sourceMorphContainer.alpha = hasSnapshot ? 1 : 0
        sourceMorphContainer.transform = .identity
        contentContainer.alpha = 0
        contentContainer.transform = CGAffineTransform(translationX: 0, y: 20).scaledBy(x: 0.96, y: 0.96)
        let controlStart = CGAffineTransform(translationX: 0, y: 18).scaledBy(x: 0.72, y: 0.72)
        for control in activeFloatingControls() {
            control.alpha = 0
            control.transform = controlStart
        }
    }

    private func releaseSource(then done: @escaping () -> Void) {
        guard !releasedSource else { done(); return }
        releasedSource = true
        guard let release = morphContext?.onRelease else { done(); return }
        release(done)
    }

    private func presentCard() {
        lightHaptic.impactOccurred(intensity: 0.6)
        if UIAccessibility.isReduceMotionEnabled {
            releaseSource {}
            UIView.performWithoutAnimation {
                applyExpandedConstraints()
                let radius = expandedCornerRadius()
                cardView.layer.cornerRadius = radius
                rimView.layer.cornerRadius = radius
                view.layoutIfNeeded()
                cardShadowView.layer.shadowPath = UIBezierPath(roundedRect: cardShadowView.bounds, cornerRadius: radius).cgPath
            }
            UIView.animate(withDuration: 0.18) {
                self.scrimView.alpha = 1
                self.cardShadowView.alpha = 1
            }
            return
        }

        UIView.performWithoutAnimation {
            applyRectConstraints(resolvedSourceRect())
            let sourceRadius = resolvedSourceRadius()
            cardView.layer.cornerRadius = sourceRadius
            rimView.layer.cornerRadius = sourceRadius
            view.layoutIfNeeded()
        }

        morphState = .expanding
        let targetRadius = expandedCornerRadius()
        applyExpandedConstraints()

        UIView.animate(
            springDuration: 0.36,
            bounce: 0.08,
            initialSpringVelocity: 0,
            delay: 0,
            options: [.allowUserInteraction, .beginFromCurrentState]
        ) {
            self.view.layoutIfNeeded()
            self.cardView.layer.cornerRadius = targetRadius
            self.rimView.layer.cornerRadius = targetRadius
            self.scrimView.alpha = 1
            self.cardShadowView.layer.shadowOpacity = 0.42
        } completion: { [weak self] _ in
            guard let self, self.morphState == .expanding else { return }
            self.morphState = .expanded
            self.morphGlassView.alpha = 0
            self.sourceMorphContainer.isHidden = true
            self.cardShadowView.layer.shadowPath = UIBezierPath(
                roundedRect: self.cardShadowView.bounds,
                cornerRadius: targetRadius
            ).cgPath
        }

        UIView.animate(withDuration: 0.09, delay: 0, options: [.curveEaseOut, .allowUserInteraction, .beginFromCurrentState]) {
            self.sourceMorphContainer.alpha = 0
            self.sourceMorphContainer.transform = CGAffineTransform(translationX: 0, y: -6)
            self.morphGlassView.alpha = 1
        }

        UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut, .allowUserInteraction, .beginFromCurrentState]) {
            self.cardFillView.alpha = 1
            self.rimView.alpha = 1
        }

        UIView.animate(
            springDuration: 0.32,
            bounce: 0.04,
            initialSpringVelocity: 0,
            delay: 0,
            options: [.allowUserInteraction, .beginFromCurrentState]
        ) {
            self.contentContainer.alpha = 1
            self.contentContainer.transform = .identity
        }

        let controls = activeFloatingControls()
        UIView.animate(
            springDuration: 0.32,
            bounce: 0.12,
            initialSpringVelocity: 0,
            delay: 0.03,
            options: [.allowUserInteraction, .beginFromCurrentState]
        ) {
            for control in controls {
                control.alpha = 1
                control.transform = .identity
            }
        }
    }

    private func dismissSheet(with files: [[String: Any]]) {
        guard !finished else { return }
        finished = true
        morphState = .dismissing
        stopCameraSession()

        let completeDismiss = { [weak self] in
            guard let self else { return }
            self.releaseSource {
                self.dismiss(animated: false) { self.onComplete(files) }
            }
        }

        if UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.15, animations: {
                self.scrimView.alpha = 0
                self.cardShadowView.alpha = 0
            }, completion: { _ in completeDismiss() })
            return
        }

        let dismissRect = resolvedDismissRect()
        let dismissRadius = min(24, dismissRect.height / 2)
        let hasSnapshot = morphContext?.origin.snapshot != nil

        UIView.performWithoutAnimation {
            let dragOffset = cardShadowView.transform.ty
            if abs(dragOffset) > 0.1 {
                cardBottomConstraint.constant += dragOffset
                cardShadowView.transform = .identity
            }
            cardShadowView.layer.shadowPath = nil
            morphGlassView.alpha = 1
            sourceWidthConstraint.constant = dismissRect.width
            sourceHeightConstraint.constant = dismissRect.height
            sourceMorphContainer.isHidden = !hasSnapshot
            sourceMorphContainer.alpha = 0
            sourceMorphContainer.transform = CGAffineTransform(translationX: 0, y: -6)
            view.layoutIfNeeded()
        }

        applyRectConstraints(dismissRect)

        UIView.animate(
            springDuration: 0.30,
            bounce: 0.02,
            initialSpringVelocity: 0,
            delay: 0,
            options: [.beginFromCurrentState]
        ) {
            self.view.layoutIfNeeded()
            self.cardView.layer.cornerRadius = dismissRadius
            self.rimView.layer.cornerRadius = dismissRadius
            self.scrimView.alpha = 0
            self.cardShadowView.layer.shadowOpacity = 0
        } completion: { _ in
            completeDismiss()
        }

        let controlEnd = CGAffineTransform(translationX: 0, y: 18).scaledBy(x: 0.72, y: 0.72)
        let allControls: [UIView] = [backButton, allPhotosButton, addPhotosButton, shutterButton, moreButton, moreBadgeDot]
        UIView.animate(withDuration: 0.12, delay: 0, options: [.curveEaseIn, .beginFromCurrentState]) {
            for control in allControls {
                control.alpha = 0
                control.transform = controlEnd
            }
        }

        UIView.animate(withDuration: 0.17, delay: 0, options: [.curveEaseIn, .beginFromCurrentState]) {
            self.contentContainer.alpha = 0
            self.contentContainer.transform = CGAffineTransform(translationX: 0, y: 14).scaledBy(x: 0.96, y: 0.96)
            self.cardFillView.alpha = 0
            self.rimView.alpha = 0
        }

        if hasSnapshot {
            UIView.animate(withDuration: 0.14, delay: 0.13, options: [.curveEaseOut, .beginFromCurrentState]) {
                self.sourceMorphContainer.alpha = 1
                self.sourceMorphContainer.transform = .identity
                self.morphGlassView.alpha = 0
            }
        }
    }

    @objc private func scrimTapped() {
        dismissSheet(with: [])
    }

    private func backTapped() {
        lightHaptic.impactOccurred(intensity: 0.7)
        if mode == .camera && canReturnToPhotos {
            switchMode(to: .photos)
        } else {
            dismissSheet(with: [])
        }
    }

    @objc private func handleSheetPan(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: view)
        let velocity = gesture.velocity(in: view)
        let height = max(cardShadowView.bounds.height, desiredCardHeight())

        switch gesture.state {
        case .began:
            guard morphState == .expanded else {
                isDraggingSheet = false
                return
            }
            if mode == .photos && collectionView.contentOffset.y > 0.5 {
                isDraggingSheet = false
                return
            }
            isDraggingSheet = true
            dragStartOffset = translation.y
        case .changed:
            if !isDraggingSheet {
                if morphState == .expanded && mode == .photos && collectionView.contentOffset.y <= 0.5 && translation.y > 4 {
                    isDraggingSheet = true
                    dragStartOffset = translation.y
                } else {
                    return
                }
            }
            let dy = translation.y - dragStartOffset
            if dy >= 0 {
                if mode == .photos { collectionView.contentOffset.y = 0 }
                cardShadowView.transform = CGAffineTransform(translationX: 0, y: dy)
                scrimView.alpha = max(0, 1 - dy / height)
            } else {
                let rubber = -rubberband(-dy, limit: 28)
                cardShadowView.transform = CGAffineTransform(translationX: 0, y: rubber)
                scrimView.alpha = 1
            }
        case .ended, .cancelled:
            guard isDraggingSheet else { return }
            isDraggingSheet = false
            let dy = max(0, translation.y - dragStartOffset)
            if dy > 110 || (dy > 20 && velocity.y > 750) {
                dismissSheet(with: [])
            } else {
                UIView.animate(springDuration: 0.34, bounce: 0.08, initialSpringVelocity: 0, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
                    self.cardShadowView.transform = .identity
                    self.scrimView.alpha = 1
                }
            }
        default:
            break
        }
    }

    private func rubberband(_ distance: CGFloat, limit: CGFloat) -> CGFloat {
        limit * (1 - exp(-distance / limit))
    }

    private func switchMode(to target: Mode) {
        guard mode != target else { return }
        mode = target
        if target == .camera {
            prepareCameraMode()
        } else {
            pauseCameraSession()
            preparePhotosMode()
        }
        applyModeUI(animated: true)
    }

    private func applyModeUI(animated: Bool) {
        let isCamera = mode == .camera
        let hasSelection = !selectedAssetIds.isEmpty

        if isCamera {
            cameraContainer.isHidden = false
            shutterButton.isHidden = false
            moreButton.isHidden = false
            updateMoreBadgeVisibility()
        } else {
            collectionView.isHidden = false
            allPhotosButton.isHidden = hasSelection
            addPhotosButton.isHidden = !hasSelection
        }

        let applyState = { [self] in
            cameraContainer.alpha = isCamera ? 1 : 0
            collectionView.alpha = isCamera ? 0 : 1
            photosFallbackView.alpha = isCamera ? 0 : (photosFallbackView.isHidden ? 0 : 1)
            allPhotosButton.alpha = (!isCamera && !hasSelection) ? 1 : 0
            addPhotosButton.alpha = (!isCamera && hasSelection) ? 1 : 0
            shutterButton.alpha = isCamera ? 1 : 0
            moreButton.alpha = isCamera ? 1 : 0
            moreBadgeDot.alpha = isCamera ? 1 : 0
            shutterButton.transform = isCamera ? .identity : CGAffineTransform(scaleX: 0.86, y: 0.86)
            moreButton.transform = isCamera ? .identity : CGAffineTransform(scaleX: 0.86, y: 0.86)
            moreBadgeDot.transform = isCamera ? .identity : CGAffineTransform(scaleX: 0.86, y: 0.86)
            allPhotosButton.transform = (!isCamera && !hasSelection) ? .identity : CGAffineTransform(scaleX: 0.92, y: 0.92)
            addPhotosButton.transform = (!isCamera && hasSelection) ? .identity : CGAffineTransform(scaleX: 0.92, y: 0.92)
        }

        let finishState: (Bool) -> Void = { [weak self] _ in
            guard let self else { return }
            let nowCamera = self.mode == .camera
            let nowSelected = !self.selectedAssetIds.isEmpty
            self.cameraContainer.isHidden = !nowCamera
            self.shutterButton.isHidden = !nowCamera
            self.moreButton.isHidden = !nowCamera
            self.updateMoreBadgeVisibility()
            self.collectionView.isHidden = nowCamera
            self.allPhotosButton.isHidden = nowCamera || nowSelected
            self.addPhotosButton.isHidden = nowCamera || !nowSelected
        }

        guard animated else {
            UIView.performWithoutAnimation {
                applyState()
                finishState(true)
            }
            return
        }

        if UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.18, animations: applyState, completion: finishState)
        } else {
            UIView.animate(springDuration: 0.32, bounce: 0.05, initialSpringVelocity: 0, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: applyState, completion: finishState)
        }
    }

    private func preparePhotosMode() {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        switch status {
        case .authorized, .limited:
            loadPhotoAssets()
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] updated in
                DispatchQueue.main.async {
                    guard let self, !self.finished else { return }
                    if updated == .authorized || updated == .limited {
                        self.loadPhotoAssets()
                    } else {
                        self.showPhotosPermissionFallback()
                    }
                }
            }
        case .denied, .restricted:
            showPhotosPermissionFallback()
        @unknown default:
            showPhotosPermissionFallback()
        }
    }

    private func loadPhotoAssets() {
        photosFallbackView.isHidden = true
        if libraryObserver == nil {
            libraryObserver = NotificationCenter.default.addObserver(
                forName: MediaPickerLibraryCache.didUpdateNotification,
                object: nil,
                queue: .main
            ) { [weak self] note in
                guard let self, !self.finished, let next = note.object as? PHFetchResult<PHAsset> else { return }
                self.applyUpdatedPhotoResult(next)
            }
        }
        if let cached = MediaPickerLibraryCache.shared.currentResult {
            fetchResult = cached
            collectionView.reloadData()
            return
        }
        MediaPickerLibraryCache.shared.fetch(thumbnailPixelSize: thumbnailPixelSize) { [weak self] result in
            guard let self, !self.finished else { return }
            self.fetchResult = result
            self.collectionView.reloadData()
        }
    }

    private func applyUpdatedPhotoResult(_ next: PHFetchResult<PHAsset>) {
        fetchResult = next
        if !selectedAssetIds.isEmpty {
            var liveIds = Set<String>()
            next.enumerateObjects { asset, _, _ in liveIds.insert(asset.localIdentifier) }
            let pruned = selectedAssetIds.filter { liveIds.contains($0) }
            if pruned.count != selectedAssetIds.count {
                selectedAssetIds = pruned
                updateSelectionPill(animated: true)
            }
        }
        collectionView.reloadData()
    }

    private func showPhotosPermissionFallback() {
        fetchResult = nil
        selectedAssetIds.removeAll()
        updateSelectionPill(animated: false)
        collectionView.reloadData()
        photosFallbackView.configure(
            symbol: "photo.on.rectangle.angled",
            title: labels.photosOffTitle,
            body: labels.photosOffBody,
            actionTitle: labels.openSettings
        ) { [weak self] in
            self?.openAppSettings()
        }
        photosFallbackView.isHidden = false
        photosFallbackView.alpha = mode == .photos ? 1 : 0
    }

    private func selectedAssets() -> [PHAsset] {
        guard !selectedAssetIds.isEmpty, let result = fetchResult else { return [] }
        var byId: [String: PHAsset] = [:]
        result.enumerateObjects { asset, _, _ in
            byId[asset.localIdentifier] = asset
        }
        return selectedAssetIds.compactMap { byId[$0] }
    }

    private func toggleSelection(for asset: PHAsset, at indexPath: IndexPath) {
        guard !exportingSelection, !finished else { return }
        let id = asset.localIdentifier
        if let existing = selectedAssetIds.firstIndex(of: id) {
            selectedAssetIds.remove(at: existing)
            selectionHaptic.selectionChanged()
            (collectionView.cellForItem(at: indexPath) as? PhotoTileCell)?.setSelectedState(false, animated: true)
            updateSelectionPill(animated: true)
            return
        }
        if !allowMultiple {
            let previous = selectedAssetIds
            selectedAssetIds = [id]
            selectionHaptic.selectionChanged()
            for visible in collectionView.indexPathsForVisibleItems {
                guard let result = fetchResult, visible.item < result.count else { continue }
                let itemAsset = result.object(at: visible.item)
                if previous.contains(itemAsset.localIdentifier) {
                    (collectionView.cellForItem(at: visible) as? PhotoTileCell)?.setSelectedState(false, animated: true)
                }
            }
            (collectionView.cellForItem(at: indexPath) as? PhotoTileCell)?.setSelectedState(true, animated: true)
            updateSelectionPill(animated: true)
            return
        }
        guard selectedAssetIds.count < maxSelection else {
            noticeHaptic.notificationOccurred(.warning)
            return
        }
        selectedAssetIds.append(id)
        selectionHaptic.selectionChanged()
        (collectionView.cellForItem(at: indexPath) as? PhotoTileCell)?.setSelectedState(true, animated: true)
        updateSelectionPill(animated: true)
    }

    private func updateSelectionPill(animated: Bool) {
        let count = selectedAssetIds.count
        let hasSelection = count > 0
        if hasSelection {
            let hasVideo = selectedAssets().contains { $0.mediaType == .video }
            let title = labels.addTitle(count: count, hasVideo: hasVideo)
            var attr = AttributedString(title)
            attr.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
            UIView.performWithoutAnimation {
                addPhotosButton.configuration?.attributedTitle = attr
                addPhotosButton.accessibilityLabel = title
                addPhotosButton.layoutIfNeeded()
            }
        }

        guard mode == .photos else { return }
        if hasSelection { addPhotosButton.isHidden = false } else { allPhotosButton.isHidden = false }

        let apply = { [self] in
            allPhotosButton.alpha = hasSelection ? 0 : 1
            allPhotosButton.transform = hasSelection ? CGAffineTransform(scaleX: 0.92, y: 0.92) : .identity
            addPhotosButton.alpha = hasSelection ? 1 : 0
            addPhotosButton.transform = hasSelection ? .identity : CGAffineTransform(scaleX: 0.92, y: 0.92)
        }
        let finish: (Bool) -> Void = { [weak self] _ in
            guard let self, self.mode == .photos else { return }
            let nowSelected = !self.selectedAssetIds.isEmpty
            self.allPhotosButton.isHidden = nowSelected
            self.addPhotosButton.isHidden = !nowSelected
        }
        guard animated else {
            UIView.performWithoutAnimation {
                apply()
                finish(true)
            }
            return
        }
        if UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.16, animations: apply, completion: finish)
        } else {
            UIView.animate(springDuration: 0.28, bounce: 0.08, initialSpringVelocity: 0, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: apply, completion: finish)
        }
    }

    private func openSystemPhotoPicker() {
        lightHaptic.impactOccurred(intensity: 0.7)
        var config = PHPickerConfiguration()
        config.selectionLimit = maxSelection
        config.filter = .any(of: [.images, .videos])
        config.preferredAssetRepresentationMode = .compatible
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        present(picker, animated: true)
    }

    private func exportSelectedAssets() {
        let assets = selectedAssets()
        guard !assets.isEmpty, !exportingSelection, !finished else { return }
        exportingSelection = true
        mediumHaptic.impactOccurred()
        collectionView.isUserInteractionEnabled = false
        addPhotosButton.isEnabled = false
        addPhotosButton.configuration?.baseForegroundColor = .clear
        addSpinner.startAnimating()

        var results = [[String: Any]?](repeating: nil, count: assets.count)
        let lock = NSLock()
        let group = DispatchGroup()

        for (index, asset) in assets.enumerated() {
            group.enter()
            Self.exportAsset(asset) { file in
                lock.lock()
                results[index] = file
                lock.unlock()
                group.leave()
            }
        }

        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            self.exportingSelection = false
            self.collectionView.isUserInteractionEnabled = true
            self.addPhotosButton.isEnabled = true
            self.addPhotosButton.configuration?.baseForegroundColor = .black
            self.addSpinner.stopAnimating()
            guard !self.finished else { return }
            let files = results.compactMap { $0 }
            if !files.isEmpty {
                self.dismissSheet(with: files)
            }
        }
    }

    private static func exportAsset(_ asset: PHAsset, completion: @escaping ([String: Any]?) -> Void) {
        if asset.mediaType == .video {
            let options = PHVideoRequestOptions()
            options.isNetworkAccessAllowed = true
            options.deliveryMode = .highQualityFormat
            PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, _ in
                if let urlAsset = avAsset as? AVURLAsset, let file = PickedFiles.copy(urlAsset.url) {
                    completion(file)
                    return
                }
                guard let avAsset, let export = AVAssetExportSession(asset: avAsset, presetName: AVAssetExportPresetMediumQuality),
                      let dir = PickedFiles.makeTempFolder() else {
                    completion(nil)
                    return
                }
                let outputURL = dir.appendingPathComponent("\(assetStem(asset)).mp4")
                export.outputURL = outputURL
                export.outputFileType = .mp4
                export.exportAsynchronously {
                    completion(export.status == .completed ? PickedFiles.describe(outputURL, type: "video/mp4") : nil)
                }
            }
            return
        }

        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.version = .current
        options.deliveryMode = .highQualityFormat
        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, uti, _, _ in
            guard let data else { completion(nil); return }
            let stem = assetStem(asset)
            if uti == UTType.png.identifier {
                completion(PickedFiles.write(data, name: "\(stem).png", type: "image/png"))
            } else if uti == UTType.gif.identifier {
                completion(PickedFiles.write(data, name: "\(stem).gif", type: "image/gif"))
            } else if uti == UTType.jpeg.identifier {
                completion(PickedFiles.write(data, name: "\(stem).jpg", type: "image/jpeg"))
            } else if let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) {
                completion(PickedFiles.write(jpeg, name: "\(stem).jpg", type: "image/jpeg"))
            } else {
                completion(nil)
            }
        }
    }

    private static func assetStem(_ asset: PHAsset) -> String {
        if let raw = PHAssetResource.assetResources(for: asset).first?.originalFilename {
            let base = (raw as NSString).deletingPathExtension
            if !base.isEmpty { return base }
        }
        return "photo-\(UUID().uuidString.prefix(8).lowercased())"
    }

    private func prepareCameraMode() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            cameraFallbackView.isHidden = true
            startCameraSessionIfPossible()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self, !self.finished else { return }
                    if granted {
                        self.cameraFallbackView.isHidden = true
                        self.startCameraSessionIfPossible()
                    } else {
                        self.showCameraFallback(denied: true)
                    }
                }
            }
        case .denied, .restricted:
            showCameraFallback(denied: true)
        @unknown default:
            showCameraFallback(denied: true)
        }
    }

    private func showCameraFallback(denied: Bool) {
        cameraAvailable = false
        shutterButton.isEnabled = false
        cameraFallbackView.configure(
            symbol: denied ? "camera.fill" : "camera",
            title: denied ? labels.cameraOffTitle : labels.takePhoto,
            body: denied ? labels.cameraOffBody : labels.cameraUnavailable,
            actionTitle: denied ? labels.openSettings : nil
        ) { [weak self] in
            self?.openAppSettings()
        }
        cameraFallbackView.isHidden = false
        rebuildMoreMenu()
    }

    private func startCameraSessionIfPossible() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            let multi = self.cameraDevice(for: .back) != nil && self.cameraDevice(for: .front) != nil
            if !self.sessionConfigured {
                guard let device = self.cameraDevice(for: self.cameraPosition),
                      let input = try? AVCaptureDeviceInput(device: device) else {
                    DispatchQueue.main.async {
                        self.hasMultipleCamerasCached = false
                        self.hasFlashCached = false
                        self.showCameraFallback(denied: false)
                    }
                    return
                }
                self.captureSession.beginConfiguration()
                self.captureSession.sessionPreset = .photo
                if self.captureSession.canAddInput(input) {
                    self.captureSession.addInput(input)
                    self.videoInput = input
                }
                if self.captureSession.canAddOutput(self.photoOutput) {
                    self.captureSession.addOutput(self.photoOutput)
                }
                self.captureSession.commitConfiguration()
                self.sessionConfigured = true
            }
            let hasFlash = self.videoInput?.device.hasFlash ?? false
            if !self.captureSession.isRunning {
                self.captureSession.startRunning()
            }
            DispatchQueue.main.async {
                self.cameraAvailable = true
                self.hasMultipleCamerasCached = multi
                self.hasFlashCached = hasFlash
                self.cameraFallbackView.isHidden = true
                self.shutterButton.isEnabled = true
                self.rebuildMoreMenu()
            }
        }
    }

    private func pauseCameraSession() {
        sessionQueue.async { [weak self] in
            guard let self, self.captureSession.isRunning else { return }
            self.captureSession.stopRunning()
        }
    }

    private func stopCameraSession() {
        sessionQueue.async { [weak self] in
            guard let self, self.captureSession.isRunning else { return }
            self.captureSession.stopRunning()
        }
    }

    private func cameraDevice(for position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
            ?? AVCaptureDevice.default(for: .video)
    }

    private func switchCameraPosition() {
        guard cameraAvailable, hasMultipleCamerasCached else { return }
        selectionHaptic.selectionChanged()
        let next: AVCaptureDevice.Position = cameraPosition == .back ? .front : .back
        sessionQueue.async { [weak self] in
            guard let self, let device = self.cameraDevice(for: next),
                  let nextInput = try? AVCaptureDeviceInput(device: device) else { return }
            self.captureSession.beginConfiguration()
            if let current = self.videoInput { self.captureSession.removeInput(current) }
            if self.captureSession.canAddInput(nextInput) {
                self.captureSession.addInput(nextInput)
                self.videoInput = nextInput
                self.cameraPosition = next
            } else if let current = self.videoInput, self.captureSession.canAddInput(current) {
                self.captureSession.addInput(current)
            }
            self.captureSession.commitConfiguration()
            let hasFlash = self.videoInput?.device.hasFlash ?? false
            DispatchQueue.main.async {
                self.hasFlashCached = hasFlash
                self.rebuildMoreMenu()
            }
        }
    }

    private func rebuildMoreMenu() {
        var topActions: [UIMenuElement] = []
        if hasMultipleCamerasCached {
            topActions.append(UIAction(title: labels.switchCamera, image: UIImage(systemName: "arrow.triangle.2.circlepath.camera")) { [weak self] _ in
                self?.switchCameraPosition()
            })
        }
        topActions.append(UIAction(title: labels.photoLibrary, image: UIImage(systemName: "photo.on.rectangle")) { [weak self] _ in
            guard let self else { return }
            self.canReturnToPhotos = false
            self.switchMode(to: .photos)
        })

        var children: [UIMenuElement] = []
        if !topActions.isEmpty {
            children.append(UIMenu(title: "", options: .displayInline, children: topActions))
        }

        if hasFlashCached {
            let modes: [(AVCaptureDevice.FlashMode, String, String)] = [
                (.auto, "\(labels.flash): \(labels.flashAuto)", "bolt.badge.automatic"),
                (.on, "\(labels.flash): \(labels.flashOn)", "bolt.fill"),
                (.off, "\(labels.flash): \(labels.flashOff)", "bolt.slash"),
            ]
            let flashActions = modes.map { modeValue, title, symbol in
                UIAction(title: title, image: UIImage(systemName: symbol), state: flashMode == modeValue ? .on : .off) { [weak self] _ in
                    guard let self else { return }
                    self.selectionHaptic.selectionChanged()
                    self.flashMode = modeValue
                    self.rebuildMoreMenu()
                }
            }
            children.append(UIMenu(title: "", options: .displayInline, children: flashActions))
        }

        moreButton.menu = UIMenu(children: children)
        updateMoreBadgeVisibility()
    }

    private func updateMoreBadgeVisibility() {
        let activeBadge = (hasFlashCached && flashMode != .off) || cameraPosition == .front
        moreBadgeDot.isHidden = mode != .camera || !activeBadge
    }

    @objc private func shutterTapped() {
        guard mode == .camera, cameraAvailable, !isCapturing, !finished else { return }
        isCapturing = true
        mediumHaptic.impactOccurred()

        shutterFlashView.alpha = 0.45
        UIView.animate(withDuration: 0.18) { self.shutterFlashView.alpha = 0 }

        let desiredFlash = flashMode
        let position = cameraPosition
        sessionQueue.async { [weak self] in
            guard let self, self.captureSession.isRunning else {
                DispatchQueue.main.async { self?.isCapturing = false }
                return
            }
            if let connection = self.photoOutput.connection(with: .video) {
                if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
                if connection.isVideoMirroringSupported { connection.isVideoMirrored = (position == .front) }
            }
            let settings = AVCapturePhotoSettings()
            if self.photoOutput.supportedFlashModes.contains(desiredFlash) {
                settings.flashMode = desiredFlash
            }
            self.photoOutput.capturePhoto(with: settings, delegate: self)
        }
    }

    @objc private func cameraTapped(_ gesture: UITapGestureRecognizer) {
        guard mode == .camera, cameraAvailable else { return }
        let point = gesture.location(in: cameraContainer)
        let devicePoint = cameraPreviewView.previewLayer.captureDevicePointConverted(fromLayerPoint: gesture.location(in: cameraPreviewView))
        focusRingView.center = point
        focusRingView.transform = CGAffineTransform(scaleX: 1.3, y: 1.3)
        focusRingView.alpha = 1
        UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut]) {
            self.focusRingView.transform = .identity
        } completion: { _ in
            UIView.animate(withDuration: 0.25, delay: 0.45) {
                self.focusRingView.alpha = 0
            }
        }
        sessionQueue.async { [weak self] in
            guard let device = self?.videoInput?.device, (try? device.lockForConfiguration()) != nil else { return }
            if device.isFocusPointOfInterestSupported {
                device.focusPointOfInterest = devicePoint
                device.focusMode = .autoFocus
            }
            if device.isExposurePointOfInterestSupported {
                device.exposurePointOfInterest = devicePoint
                device.exposureMode = .autoExpose
            }
            device.unlockForConfiguration()
        }
    }

    @objc private func cameraPinched(_ gesture: UIPinchGestureRecognizer) {
        guard mode == .camera, cameraAvailable else { return }
        if gesture.state == .began {
            pinchStartZoom = videoInput?.device.videoZoomFactor ?? 1
        }
        let scale = gesture.scale
        let start = pinchStartZoom
        sessionQueue.async { [weak self] in
            guard let device = self?.videoInput?.device, (try? device.lockForConfiguration()) != nil else { return }
            let maxZoom = min(device.activeFormat.videoMaxZoomFactor, 8.0)
            device.videoZoomFactor = max(1.0, min(start * scale, maxZoom))
            device.unlockForConfiguration()
        }
    }

    private func openAppSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

extension MediaPickerSheetViewController: UICollectionViewDataSource, UICollectionViewDelegate {
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        guard photosFallbackView.isHidden else { return 0 }
        return fetchResult?.count ?? 0
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: PhotoTileCell.reuseId, for: indexPath) as! PhotoTileCell
        guard let result = fetchResult, indexPath.item < result.count else { return cell }
        let asset = result.object(at: indexPath.item)
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        let isPicked = selectedAssetIds.contains(asset.localIdentifier)
        cell.configure(asset: asset, manager: imageManager, targetSize: thumbnailPixelSize, options: options, selected: isPicked)
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: false)
        guard let result = fetchResult, indexPath.item < result.count else { return }
        toggleSelection(for: result.object(at: indexPath.item), at: indexPath)
    }
}

extension MediaPickerSheetViewController: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let file: [String: Any]? = {
            guard error == nil, let data = photo.fileDataRepresentation(), let image = UIImage(data: data) else { return nil }
            return PickedFiles.image(image, index: 0)
        }()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.isCapturing = false
            guard !self.finished, let file else { return }
            self.dismissSheet(with: [file])
        }
    }
}

extension MediaPickerSheetViewController: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true) { [weak self] in
            guard let self, !self.finished, !results.isEmpty else { return }
            PickedFiles.load(results: results) { [weak self] files in
                self?.dismissSheet(with: files)
            }
        }
    }
}

extension MediaPickerSheetViewController: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        gestureRecognizer === panGesture && otherGestureRecognizer === collectionView.panGestureRecognizer
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === panGesture else { return true }
        let velocity = panGesture.velocity(in: cardView)
        return abs(velocity.y) >= abs(velocity.x)
    }
}

private final class CameraPreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

private final class PhotoTileCell: UICollectionViewCell {
    static let reuseId = "PhotoTileCell"
    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    private let imageView = UIImageView()
    private let selectedScrim = UIView()
    private let badgeView = UIView()
    private let badgeCheck = UIImageView()
    private let durationLabel = UILabel()
    private var requestId: PHImageRequestID = PHInvalidImageRequestID
    private weak var manager: PHImageManager?
    private var assetIdentifier: String?
    private var picked = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = UIColor(white: 0.13, alpha: 1)
        contentView.clipsToBounds = true
        isAccessibilityElement = true
        accessibilityTraits = .button

        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(imageView)

        selectedScrim.backgroundColor = UIColor.black.withAlphaComponent(0.22)
        selectedScrim.alpha = 0
        selectedScrim.isUserInteractionEnabled = false
        selectedScrim.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(selectedScrim)

        badgeView.backgroundColor = .white
        badgeView.layer.cornerRadius = 11.5
        badgeView.layer.shadowColor = UIColor.black.cgColor
        badgeView.layer.shadowOpacity = 0.32
        badgeView.layer.shadowRadius = 4
        badgeView.layer.shadowOffset = CGSize(width: 0, height: 1)
        badgeView.alpha = 0
        badgeView.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
        badgeView.isUserInteractionEnabled = false
        badgeView.isAccessibilityElement = false
        badgeView.accessibilityElementsHidden = true
        badgeView.translatesAutoresizingMaskIntoConstraints = false

        badgeCheck.image = UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold))
        badgeCheck.tintColor = .black
        badgeCheck.contentMode = .center
        badgeCheck.isAccessibilityElement = false
        badgeCheck.accessibilityLabel = nil
        badgeCheck.translatesAutoresizingMaskIntoConstraints = false
        badgeView.addSubview(badgeCheck)
        contentView.addSubview(badgeView)

        durationLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        durationLabel.textColor = .white
        durationLabel.layer.shadowColor = UIColor.black.cgColor
        durationLabel.layer.shadowOpacity = 0.85
        durationLabel.layer.shadowRadius = 3
        durationLabel.layer.shadowOffset = .zero
        durationLabel.translatesAutoresizingMaskIntoConstraints = false
        durationLabel.isHidden = true
        contentView.addSubview(durationLabel)

        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: contentView.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),

            selectedScrim.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            selectedScrim.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            selectedScrim.topAnchor.constraint(equalTo: contentView.topAnchor),
            selectedScrim.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),

            badgeView.widthAnchor.constraint(equalToConstant: 23),
            badgeView.heightAnchor.constraint(equalToConstant: 23),
            badgeView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -7),
            badgeView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -7),

            badgeCheck.centerXAnchor.constraint(equalTo: badgeView.centerXAnchor),
            badgeCheck.centerYAnchor.constraint(equalTo: badgeView.centerYAnchor),

            durationLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 6),
            durationLabel.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -5),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func prepareForReuse() {
        super.prepareForReuse()
        if requestId != PHInvalidImageRequestID {
            manager?.cancelImageRequest(requestId)
            requestId = PHInvalidImageRequestID
        }
        assetIdentifier = nil
        imageView.image = nil
        durationLabel.isHidden = true
        setSelectedState(false, animated: false)
    }

    func configure(asset: PHAsset, manager: PHImageManager, targetSize: CGSize, options: PHImageRequestOptions, selected: Bool) {
        if requestId != PHInvalidImageRequestID {
            self.manager?.cancelImageRequest(requestId)
        }
        self.manager = manager
        assetIdentifier = asset.localIdentifier
        if asset.mediaType == .video {
            let total = Int(round(asset.duration))
            let formatted = String(format: "%d:%02d", total / 60, total % 60)
            durationLabel.text = formatted
            durationLabel.isHidden = false
            accessibilityLabel = "Video, \(formatted)"
        } else {
            durationLabel.isHidden = true
            if let date = asset.creationDate {
                accessibilityLabel = "Photo, \(Self.dateFormatter.string(from: date))"
            } else {
                accessibilityLabel = "Photo"
            }
        }
        setSelectedState(selected, animated: false)
        let expectedId = asset.localIdentifier
        requestId = manager.requestImage(for: asset, targetSize: targetSize, contentMode: .aspectFill, options: options) { [weak self] image, _ in
            guard let self, self.assetIdentifier == expectedId, let image else { return }
            self.imageView.image = image
        }
    }

    func setSelectedState(_ selected: Bool, animated: Bool) {
        picked = selected
        accessibilityTraits = selected ? [.button, .selected] : .button
        let apply = { [self] in
            selectedScrim.alpha = selected ? 1 : 0
            badgeView.alpha = selected ? 1 : 0
            badgeView.transform = selected ? .identity : CGAffineTransform(scaleX: 0.6, y: 0.6)
        }
        guard animated else {
            UIView.performWithoutAnimation(apply)
            return
        }
        if UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.14, animations: apply)
        } else {
            UIView.animate(springDuration: 0.28, bounce: selected ? 0.24 : 0, initialSpringVelocity: 0, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: apply)
        }
    }

    override var isHighlighted: Bool {
        didSet {
            UIView.animate(withDuration: 0.12) {
                self.imageView.alpha = self.isHighlighted ? 0.78 : 1
            }
        }
    }
}

private final class ShutterButton: UIControl {
    private let glassBackdrop: UIVisualEffectView
    private let fallbackRing = UIView()
    private let innerDisc = UIView()

    override init(frame: CGRect) {
        if #available(iOS 26.0, *) {
            let effect = UIGlassEffect(style: .regular)
            effect.isInteractive = true
            effect.tintColor = UIColor(white: 0.05, alpha: 0.5)
            glassBackdrop = UIVisualEffectView(effect: effect)
            glassBackdrop.cornerConfiguration = .capsule()
            fallbackRing.isHidden = true
        } else {
            glassBackdrop = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterialDark))
            fallbackRing.isHidden = false
        }
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityTraits = .button
        overrideUserInterfaceStyle = .dark

        glassBackdrop.isUserInteractionEnabled = false
        if #unavailable(iOS 26.0) {
            glassBackdrop.clipsToBounds = true
        }
        addSubview(glassBackdrop)

        fallbackRing.isUserInteractionEnabled = false
        fallbackRing.backgroundColor = .clear
        fallbackRing.layer.borderWidth = 2.5
        fallbackRing.layer.borderColor = UIColor.white.withAlphaComponent(0.85).cgColor
        addSubview(fallbackRing)

        innerDisc.isUserInteractionEnabled = false
        innerDisc.backgroundColor = UIColor(white: 0.96, alpha: 1)
        innerDisc.layer.shadowColor = UIColor.black.cgColor
        innerDisc.layer.shadowOpacity = 0.24
        innerDisc.layer.shadowRadius = 4
        innerDisc.layer.shadowOffset = .zero
        glassBackdrop.contentView.addSubview(innerDisc)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = min(bounds.width, bounds.height)
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        glassBackdrop.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        glassBackdrop.center = center
        if #unavailable(iOS 26.0) {
            glassBackdrop.layer.cornerRadius = side / 2
            fallbackRing.bounds = glassBackdrop.bounds
            fallbackRing.center = center
            fallbackRing.layer.cornerRadius = side / 2
        }

        let discSize = side - 12
        innerDisc.bounds = CGRect(x: 0, y: 0, width: discSize, height: discSize)
        innerDisc.center = CGPoint(x: glassBackdrop.bounds.midX, y: glassBackdrop.bounds.midY)
        innerDisc.layer.cornerRadius = discSize / 2
    }

    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != oldValue else { return }
            let pressed = isHighlighted
            UIView.animate(springDuration: pressed ? 0.12 : 0.3, bounce: pressed ? 0 : 0.18, initialSpringVelocity: 0, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
                self.glassBackdrop.transform = pressed ? CGAffineTransform(scaleX: 1.05, y: 1.05) : .identity
                self.innerDisc.transform = pressed ? CGAffineTransform(scaleX: 0.85, y: 0.85) : .identity
                self.innerDisc.backgroundColor = pressed ? UIColor(white: 0.86, alpha: 1) : UIColor(white: 0.96, alpha: 1)
            }
        }
    }

    override var isEnabled: Bool {
        didSet {
            innerDisc.alpha = isEnabled ? 1 : 0.9
        }
    }
}

private final class EmptyNoticeView: UIView {
    private let iconView = UIImageView()
    private let titleLabel = UILabel()
    private let bodyLabel = UILabel()
    private let actionButton = UIButton(configuration: .filled())
    private var actionHandler: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        iconView.tintColor = UIColor.white.withAlphaComponent(0.55)
        iconView.contentMode = .center

        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = .white
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 0

        bodyLabel.font = .systemFont(ofSize: 14)
        bodyLabel.textColor = UIColor.white.withAlphaComponent(0.68)
        bodyLabel.textAlignment = .center
        bodyLabel.numberOfLines = 0

        var config = UIButton.Configuration.filled()
        config.cornerStyle = .capsule
        config.baseBackgroundColor = UIColor.white.withAlphaComponent(0.16)
        config.baseForegroundColor = .white
        config.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 18, bottom: 10, trailing: 18)
        actionButton.configuration = config
        actionButton.addAction(UIAction { [weak self] _ in self?.actionHandler?() }, for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [iconView, titleLabel, bodyLabel, actionButton])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 10
        stack.setCustomSpacing(16, after: bodyLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(symbol: String, title: String, body: String, actionTitle: String?, onAction: (() -> Void)?) {
        iconView.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .medium))
        titleLabel.text = title
        bodyLabel.text = body
        actionHandler = onAction
        if let actionTitle {
            var attr = AttributedString(actionTitle)
            attr.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
            actionButton.configuration?.attributedTitle = attr
            actionButton.isHidden = false
        } else {
            actionButton.isHidden = true
        }
    }
}
