// WebCodecs audio types (not in TypeScript 5.6's DOM lib).
interface EncodedAudioChunk { readonly byteLength: number; readonly timestamp: number; readonly duration: number | null; copyTo(dst: ArrayBufferView): void }
interface EncodedAudioChunkMetadata { decoderConfig?: { codec: string; sampleRate: number; numberOfChannels: number; description?: BufferSource } }
interface AudioEncoderConfig { codec: string; sampleRate: number; numberOfChannels: number; bitrate?: number }
interface AudioDataInit { format: 'f32-planar' | 'f32' | 's16' | 's16-planar'; sampleRate: number; numberOfFrames: number; numberOfChannels: number; timestamp: number; data: BufferSource }
declare class AudioData { constructor(init: AudioDataInit); close(): void; readonly numberOfFrames: number }
declare class AudioEncoder {
  constructor(init: { output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void; error: (e: unknown) => void });
  configure(c: AudioEncoderConfig): void;
  encode(d: AudioData): void;
  flush(): Promise<void>;
  close(): void;
  readonly encodeQueueSize: number;
  static isConfigSupported(c: AudioEncoderConfig): Promise<{ supported: boolean }>;
}
