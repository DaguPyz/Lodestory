import type {ProjectByteView, ProjectFileBytes, ProjectFileData} from "@lodestory/sdk/project-storage";

const privateBytes = new WeakMap<ProjectByteView, Uint8Array>();
const legacyProjections = new WeakMap<ProjectByteView, ProjectFileBytes>();
const isView = ArrayBuffer.isView;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const Uint8ArrayConstructor = Uint8Array;
const uint8ArrayPrototype = Uint8ArrayConstructor.prototype;
const typedArrayPrototype = getPrototypeOf(uint8ArrayPrototype);
const defineProperty = Object.defineProperty;
const typedArrayNameGetter = getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const typedArrayLengthGetter = getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get;
const typedArrayByteLengthGetter = getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayBufferGetter = getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const arrayBufferByteLengthGetter = getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const arrayBufferResizableGetter = getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const uint8ArraySet = uint8ArrayPrototype.set;
const uint8ArraySubarray = uint8ArrayPrototype.subarray;
const uint8ArrayIterator = uint8ArrayPrototype[Symbol.iterator];
const arrayBufferIsView = ArrayBuffer.isView;
const arrayFrom = Array.from.bind(Array);
const arrayPrototype = Array.prototype;
const arrayIterator = arrayPrototype[Symbol.iterator];
const SafeUint8ArrayConstructor = function () {};
defineProperty(SafeUint8ArrayConstructor, Symbol.species, {value: Uint8ArrayConstructor});

function createPrivateBuffer(length: number): Uint8Array {
  const buffer = new Uint8ArrayConstructor(length);
  // Prevent subarray() from consulting the mutable global Uint8Array constructor/species.
  defineProperty(buffer, "constructor", {value: SafeUint8ArrayConstructor});
  return buffer;
}

function isUint8ArrayBrand(value: unknown): boolean {
  if (!isView(value) || !typedArrayNameGetter) return false;
  try {
    return typedArrayNameGetter.call(value) === "Uint8Array";
  } catch {
    return false;
  }
}

function getUint8Length(value: unknown): number | null {
  if (!isUint8ArrayBrand(value) || !typedArrayLengthGetter) return null;
  try {
    return typedArrayLengthGetter.call(value) as number;
  } catch {
    return null;
  }
}

function bufferLength(value: Uint8Array): number {
  return typedArrayLengthGetter!.call(value) as number;
}

function isFastNativeUint8Array(value: unknown): value is Uint8Array {
  try {
    if (!arrayBufferIsView(value) || !typedArrayNameGetter || !typedArrayLengthGetter || !typedArrayBufferGetter
      || !arrayBufferByteLengthGetter || typedArrayNameGetter.call(value) !== "Uint8Array"
      || getPrototypeOf(value) !== uint8ArrayPrototype
      || getOwnPropertyDescriptor(value, Symbol.iterator)
      || getOwnPropertyDescriptor(uint8ArrayPrototype, Symbol.iterator)
      || getOwnPropertyDescriptor(typedArrayPrototype, Symbol.iterator)?.value !== uint8ArrayIterator) return false;
    const buffer = typedArrayBufferGetter.call(value);
    arrayBufferByteLengthGetter.call(buffer);
    if (arrayBufferResizableGetter?.call(buffer) === true) return false;
    // Preserve detached-buffer validation before using indexed reads.
    uint8ArrayIterator.call(value);
    return true;
  } catch {
    return false;
  }
}

function isFastNativeArray(value: unknown): value is readonly number[] {
  return Array.isArray(value)
    && getPrototypeOf(value) === arrayPrototype
    && !getOwnPropertyDescriptor(value, Symbol.iterator)
    && getOwnPropertyDescriptor(arrayPrototype, Symbol.iterator)?.value === arrayIterator;
}

function equalBuffers(left: Uint8Array, right: Uint8Array): boolean {
  const length = bufferLength(left);
  if (length !== bufferLength(right)) return false;
  for (let index = 0; index < length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function isViewLike(value: unknown): value is ProjectByteView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const byteLength = (value as ProjectByteView).byteLength;
    return Number.isSafeInteger(byteLength)
      && byteLength >= 0
      && typeof (value as ProjectByteView).copyTo === "function"
      && typeof (value as ProjectByteView).equals === "function";
  } catch {
    return false;
  }
}

/** True only for capsules created here; these may be safely reused as canonical data. */
export function isOwnedProjectByteView(value: unknown): value is ProjectByteView {
  return typeof value === "object" && value !== null && privateBytes.has(value as ProjectByteView);
}

/** Structural guard for the public view contract, including views from another implementation. */
export function isProjectByteView(value: unknown): value is ProjectByteView {
  return isOwnedProjectByteView(value) || isViewLike(value);
}

function captureBuffer(data: ProjectFileData): Uint8Array {
  if (isOwnedProjectByteView(data)) return privateBytes.get(data)!;

  if (isFastNativeArray(data)) {
    const captured = createPrivateBuffer(data.length);
    for (let index = 0; index < data.length; index++) {
      const byte = data[index];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("文件字节必须是 0 到 255 的整数。");
      captured[index] = byte;
    }
    return captured;
  }

  if (isFastNativeUint8Array(data)) {
    const length = bufferLength(data);
    const captured = createPrivateBuffer(length);
    uint8ArraySet.call(captured, data as Uint8Array);
    return captured;
  }

  if (isViewLike(data)) {
    const foreignData = data as unknown as ProjectByteView;
    const scratch = createPrivateBuffer(foreignData.byteLength);
    const copy = foreignData.copyTo;
    copy.call(foreignData, scratch);
    // A foreign view may retain its target, so clone the scratch after the call.
    const captured = createPrivateBuffer(bufferLength(scratch));
    uint8ArraySet.call(captured, scratch);
    return captured;
  }

  if (Array.isArray(data) || isUint8ArrayBrand(data)) {
    const values = arrayFrom(data) as number[];
    const captured = createPrivateBuffer(values.length);
    for (let index = 0; index < values.length; index++) {
      const byte = values[index];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("文件字节必须是 0 到 255 的整数。");
      captured[index] = byte;
    }
    return captured;
  }

  throw new Error("文件内容必须是字节数组。");
}

function copyTo(target: Uint8Array, source: Uint8Array, targetOffset = 0, sourceOffset = 0, length?: number) {
  const targetLength = getUint8Length(target);
  const sourceLength = typedArrayLengthGetter?.call(source) as number | undefined;
  const copyLength = length === undefined ? (sourceLength === undefined ? undefined : sourceLength - sourceOffset) : length;
  if (targetLength === null) throw new TypeError("copyTo target must be a Uint8Array.");
  if (sourceLength === undefined || copyLength === undefined || ![targetOffset, sourceOffset, copyLength].every(Number.isSafeInteger)
    || targetOffset < 0 || sourceOffset < 0 || copyLength < 0
    || sourceOffset > sourceLength || copyLength > sourceLength - sourceOffset
    || targetOffset > targetLength || copyLength > targetLength - targetOffset) {
    throw new RangeError("copyTo range is outside the byte view or target.");
  }
  uint8ArraySet.call(target, uint8ArraySubarray.call(source, sourceOffset, sourceOffset + copyLength), targetOffset);
}

/** Copy data into a compact, immutable capsule whose mutable Uint8Array never escapes. */
export function createProjectByteView(data: ProjectFileData): ProjectByteView {
  if (isOwnedProjectByteView(data)) return data;
  const bytes = captureBuffer(data);
  let view!: ProjectByteView;
  view = Object.freeze({
    get byteLength() { return typedArrayByteLengthGetter!.call(bytes) as number; },
    copyTo(target: Uint8Array, targetOffset = 0, sourceOffset = 0, length?: number) {
      copyTo(target, bytes, targetOffset, sourceOffset, length);
    },
    equals(other: ProjectFileData) {
      if (other === view) return true;
      const ownLength = bufferLength(bytes);
      if (isOwnedProjectByteView(other)) {
        const otherBytes = privateBytes.get(other)!;
        return equalBuffers(bytes, otherBytes);
      }
      if (isFastNativeArray(other)) {
        if (other.length !== ownLength) return false;
        for (let index = 0; index < ownLength; index++) if (bytes[index] !== other[index]) return false;
        return true;
      }
      const otherUint8Length = getUint8Length(other);
      if (otherUint8Length !== null) {
        if (otherUint8Length !== ownLength) return false;
        try {
          const compareBytes = isFastNativeUint8Array(other) ? other as Uint8Array : captureBuffer(other);
          return equalBuffers(bytes, compareBytes);
        } catch {
          return false;
        }
      }
      if (isViewLike(other)) {
        try {
          const captured = captureBuffer(other);
          return equalBuffers(bytes, captured);
        } catch {
          return false;
        }
      }
      if (Array.isArray(other)) {
        try { return equalBuffers(bytes, captureBuffer(other)); }
        catch { return false; }
      }
      return false;
    },
  });
  privateBytes.set(view, bytes);
  return view;
}

/** Materialize a fresh dense number array for the legacy ProjectFile.bytes projection. */
export function copyProjectByteViewToArray(data: ProjectByteView): number[] {
  const bytes = isOwnedProjectByteView(data) ? privateBytes.get(data)! : captureBuffer(data);
  const length = bufferLength(bytes);
  const result = new Array<number>(length);
  for (let index = 0; index < length; index++) result[index] = bytes[index];
  return result;
}

/** Compare validated canonical data without materializing a legacy array. */
export function projectFileDataEquals(left: ProjectFileData, right: ProjectFileData): boolean {
  if (left === right) return true;
  if (isOwnedProjectByteView(left)) return left.equals(right);
  if (isOwnedProjectByteView(right)) return right.equals(left);
  const leftFastArray = isFastNativeArray(left);
  const rightFastArray = isFastNativeArray(right);
  const leftFastUint8 = isFastNativeUint8Array(left);
  const rightFastUint8 = isFastNativeUint8Array(right);
  if ((leftFastArray || leftFastUint8) && (rightFastArray || rightFastUint8)) {
    const leftLength = leftFastArray ? left.length : bufferLength(left as Uint8Array);
    const rightLength = rightFastArray ? right.length : bufferLength(right as Uint8Array);
    if (leftLength !== rightLength) return false;
    for (let index = 0; index < leftLength; index++) {
      const leftByte = leftFastArray ? left[index] : (left as Uint8Array)[index];
      const rightByte = rightFastArray ? right[index] : (right as Uint8Array)[index];
      if (leftByte !== rightByte) return false;
    }
    return true;
  }
  if (isProjectByteView(left) || isProjectByteView(right)
    || Array.isArray(left) || Array.isArray(right)
    || getUint8Length(left) !== null || getUint8Length(right) !== null) {
    try { return equalBuffers(captureBuffer(left), captureBuffer(right)); }
    catch { return false; }
  }
  return false;
}

/** Turn a private view into a frozen compatibility array when the legacy getter is explicitly read. */
export function materializeProjectByteView(data: ProjectByteView): ProjectFileBytes {
  if (isOwnedProjectByteView(data)) {
    const existing = legacyProjections.get(data);
    if (existing) return existing;
    const projection = Object.freeze(copyProjectByteViewToArray(data));
    legacyProjections.set(data, projection);
    return projection;
  }
  const bytes = copyProjectByteViewToArray(data);
  return Object.freeze(bytes);
}
