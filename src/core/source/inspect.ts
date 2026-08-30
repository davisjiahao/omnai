import { isProxy } from 'node:util/types';
import { runAuthenticatedSourceCapture } from '../authority/context-builder.js';
import { resolveCurrentSource } from './resolver.js';
import {
  SourceResolutionError,
  type InspectedCurrentSource,
  type SourceCaptureSession,
  type SourceInspectLocator,
} from './types.js';

const objectFreezeIntrinsic = Object.freeze;
const Uint8ArrayIntrinsic = Uint8Array;

export async function inspectCurrentSource(
  session: SourceCaptureSession,
  locator: SourceInspectLocator | unknown,
): Promise<InspectedCurrentSource> {
  if (peekKind(locator) === 'contract') {
    return runAuthenticatedSourceCapture(session, async () => {
      throw new SourceResolutionError('SOURCE_KIND_UNAVAILABLE', 'contract');
    });
  }
  const resolved = await resolveCurrentSource(session, locator as SourceInspectLocator);
  const privateBytes = resolved.copyCanonicalBytes();
  return objectFreezeIntrinsic({
    sourceRef: resolved.sourceRef,
    byteLength: privateBytes.byteLength,
    copyCanonicalBytes(): Uint8Array {
      const copy = new Uint8ArrayIntrinsic(privateBytes.byteLength);
      for (let index = 0; index < privateBytes.byteLength; index += 1) copy[index] = privateBytes[index]!;
      return copy;
    },
  });
}

function peekKind(locator: unknown): unknown {
  if (locator === null || typeof locator !== 'object' || isProxy(locator)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(locator, 'kind');
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}
