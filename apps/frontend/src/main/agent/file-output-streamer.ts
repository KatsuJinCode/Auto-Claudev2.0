import { EventEmitter } from 'events';
import * as fs from 'fs';
import { existsSync, statSync, watch, watchFile, unwatchFile, FSWatcher, constants } from 'fs';
import * as os from 'os';

/**
 * Options for configuring the FileOutputStreamer
 */
export interface FileOutputStreamerOptions {
  /**
   * If true, start reading from end of file (skip existing content).
   * If false, read from beginning (replay all existing content).
   * Defaults to false.
   */
  seekToEnd?: boolean;

  /**
   * Polling interval in milliseconds when using watchFile (fs.watchFile mode).
   * Defaults to 500ms. Smaller values = more responsive but higher CPU.
   */
  pollInterval?: number;

  /**
   * Whether to use fs.watch (event-based) or fs.watchFile (polling-based).
   * - 'watch': Uses fs.watch - more efficient but less reliable on some platforms
   * - 'watchFile': Uses fs.watchFile - polling-based, more reliable cross-platform
   * Defaults to 'watchFile' for cross-platform reliability.
   */
  watchMode?: 'watch' | 'watchFile';

  /**
   * Encoding for reading the file. Defaults to 'utf-8'.
   */
  encoding?: BufferEncoding;
}

/**
 * Events emitted by FileOutputStreamer
 */
export interface FileOutputStreamerEvents {
  /** Emitted for each complete line read from the file */
  line: (line: string) => void;
  /** Emitted for raw data chunks (before line splitting) */
  data: (chunk: string) => void;
  /** Emitted when an error occurs */
  error: (error: Error) => void;
  /** Emitted when the streamer is started */
  start: (filePath: string, position: number) => void;
  /** Emitted when the streamer is stopped */
  stop: (filePath: string, finalPosition: number) => void;
  /** Emitted when end of file is reached (no more data currently) */
  eof: (position: number) => void;
  /**
   * Emitted when seekToEnd is used and existing content is skipped.
   * This is useful for reconnection scenarios where you want to know
   * how much content was skipped.
   */
  seeked: (skippedBytes: number, totalFileSize: number) => void;
}

/**
 * FileOutputStreamer - Tails a file and emits events for new content
 *
 * This class provides a cross-platform way to watch a growing file and
 * stream new content as it's appended. It's designed for watching agent
 * output files that are being written to by a detached process.
 *
 * Key features:
 * - Uses shared read access to avoid blocking the writer (Windows compatible)
 * - Emits line-by-line events for easy log processing
 * - Supports seek-to-end for reconnection scenarios (skip existing content)
 * - Handles partial lines at the end of reads
 * - Two watch modes: fs.watch (event-based) or fs.watchFile (polling)
 *
 * @example
 * ```typescript
 * const streamer = new FileOutputStreamer();
 *
 * streamer.on('line', (line) => {
 *   console.log('New line:', line);
 * });
 *
 * streamer.on('error', (error) => {
 *   console.error('Streamer error:', error);
 * });
 *
 * // For reconnection: skip existing content and only show new output
 * streamer.on('seeked', (skippedBytes, totalSize) => {
 *   console.log(`Reconnected: skipped ${skippedBytes} bytes of existing output`);
 * });
 *
 * // Start tailing from end of file (for reconnection)
 * streamer.start('/path/to/agent.log', { seekToEnd: true });
 *
 * // Check reconnection state
 * console.log('Skipped:', streamer.getSkippedBytes(), 'bytes');
 * console.log('Was seekToEnd used:', streamer.wasSeekToEndUsed());
 *
 * // Later, stop the streamer
 * streamer.stop();
 * ```
 */
export class FileOutputStreamer extends EventEmitter {
  /** Path to the file being tailed */
  private filePath: string | null = null;

  /** Current read position in the file */
  private readPosition: number = 0;

  /** File descriptor for reading (opened with shared access) */
  private fd: number | null = null;

  /** Whether the streamer is currently active */
  private isActive: boolean = false;

  /** FSWatcher instance (for 'watch' mode) */
  private fsWatcher: FSWatcher | null = null;

  /** Buffer for incomplete lines (partial data at end of read) */
  private lineBuffer: string = '';

  /** Current options */
  private options: Required<FileOutputStreamerOptions>;

  /** Default options */
  private static readonly DEFAULT_OPTIONS: Required<FileOutputStreamerOptions> = {
    seekToEnd: false,
    pollInterval: 500,
    watchMode: 'watchFile',
    encoding: 'utf-8'
  };

  /** Flags used to open the file */
  private openFlags: number = 0;

  /** Number of bytes skipped when seekToEnd was used */
  private skippedBytes: number = 0;

  /** Whether seekToEnd was used for current streaming session */
  private usedSeekToEnd: boolean = false;

  /** The initial file size when streaming started */
  private initialFileSize: number = 0;

  constructor() {
    super();
    this.options = { ...FileOutputStreamer.DEFAULT_OPTIONS };
  }

  /**
   * Start tailing a file
   *
   * Opens the file with shared read access and begins watching for changes.
   * On Windows, this uses flags that allow the file to be written by another
   * process while we read (avoiding EBUSY errors).
   *
   * @param filePath - Absolute path to the file to tail
   * @param options - Configuration options
   * @throws Error if file doesn't exist or cannot be opened
   */
  start(filePath: string, options: FileOutputStreamerOptions = {}): void {
    // Prevent double-start
    if (this.isActive) {
      throw new Error('FileOutputStreamer is already active. Call stop() first.');
    }

    // Merge options with defaults
    this.options = { ...FileOutputStreamer.DEFAULT_OPTIONS, ...options };

    // Verify file exists
    if (!existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    this.filePath = filePath;
    this.lineBuffer = '';
    this.skippedBytes = 0;
    this.usedSeekToEnd = this.options.seekToEnd;
    this.initialFileSize = 0;

    // Get initial file position
    try {
      const stats = statSync(filePath);
      this.initialFileSize = stats.size;

      if (this.options.seekToEnd) {
        // Seek to end: skip existing content (reconnection mode)
        this.readPosition = stats.size;
        this.skippedBytes = stats.size;
      } else {
        // Start from beginning: replay all content
        this.readPosition = 0;
        this.skippedBytes = 0;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stat file ${filePath}: ${message}`);
    }

    // Open file with explicit read-only and non-blocking flags for shared access
    // On Windows, Node.js opens files with FILE_SHARE_READ | FILE_SHARE_WRITE by default,
    // which allows other processes to continue writing while we read.
    //
    // We use explicit fs.constants flags instead of string mode for better control:
    // - O_RDONLY: Read-only access, ensures we don't interfere with writes
    // - O_NONBLOCK: Non-blocking mode (Unix only), prevents blocking on file operations
    //
    // Note: O_NONBLOCK doesn't exist on Windows, so we detect the platform and only
    // include it on Unix-like systems where it provides true non-blocking behavior.
    try {
      const isWindows = os.platform() === 'win32';

      // Build file open flags
      // O_RDONLY is required for read-only access
      this.openFlags = constants.O_RDONLY;

      // Add O_NONBLOCK on Unix platforms for non-blocking reads
      // This ensures reads don't block if the file is being actively written
      // On Windows, this flag is undefined/not supported, so we skip it
      if (!isWindows && constants.O_NONBLOCK !== undefined) {
        this.openFlags = this.openFlags | constants.O_NONBLOCK;
      }

      this.fd = fs.openSync(filePath, this.openFlags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to open file ${filePath}: ${message}`);
    }

    this.isActive = true;

    // Emit start event
    this.emit('start', filePath, this.readPosition);

    // Emit seeked event when skipping existing content (for reconnection)
    if (this.options.seekToEnd && this.skippedBytes > 0) {
      this.emit('seeked', this.skippedBytes, this.initialFileSize);
    }

    // If not seeking to end, read existing content first
    if (!this.options.seekToEnd) {
      this.readNewContent();
    }

    // Start watching for changes
    if (this.options.watchMode === 'watch') {
      this.startFsWatch();
    } else {
      this.startFsWatchFile();
    }
  }

  /**
   * Stop tailing the file
   *
   * Cleans up the file watcher and closes the file descriptor.
   * Safe to call multiple times.
   */
  stop(): void {
    if (!this.isActive) {
      return;
    }

    const filePath = this.filePath;
    const finalPosition = this.readPosition;

    // Stop file watching
    if (this.options.watchMode === 'watch') {
      if (this.fsWatcher) {
        this.fsWatcher.close();
        this.fsWatcher = null;
      }
    } else {
      if (this.filePath) {
        try {
          unwatchFile(this.filePath);
        } catch {
          // Ignore unwatch errors
        }
      }
    }

    // Close file descriptor
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Ignore close errors
      }
      this.fd = null;
    }

    // Flush any remaining partial line
    if (this.lineBuffer.length > 0) {
      this.emit('line', this.lineBuffer);
      this.lineBuffer = '';
    }

    this.isActive = false;
    this.filePath = null;
    this.openFlags = 0;
    this.skippedBytes = 0;
    this.usedSeekToEnd = false;
    this.initialFileSize = 0;

    // Emit stop event
    if (filePath) {
      this.emit('stop', filePath, finalPosition);
    }
  }

  /**
   * Check if the streamer is currently active
   */
  getIsActive(): boolean {
    return this.isActive;
  }

  /**
   * Get the current read position in the file
   */
  getReadPosition(): number {
    return this.readPosition;
  }

  /**
   * Get the file path being tailed
   */
  getFilePath(): string | null {
    return this.filePath;
  }

  /**
   * Get the number of bytes that were skipped when seekToEnd was used.
   *
   * This is useful for reconnection scenarios to know how much existing
   * content was not replayed. Returns 0 if seekToEnd was not used or
   * if the file was empty when streaming started.
   */
  getSkippedBytes(): number {
    return this.skippedBytes;
  }

  /**
   * Check if seekToEnd was used for the current streaming session.
   *
   * Returns true if the streamer was started with seekToEnd: true,
   * meaning it's in reconnection mode and skipped existing content.
   */
  wasSeekToEndUsed(): boolean {
    return this.usedSeekToEnd;
  }

  /**
   * Get the initial file size when streaming started.
   *
   * This can be compared with getReadPosition() to understand how much
   * new content has been read since streaming began.
   */
  getInitialFileSize(): number {
    return this.initialFileSize;
  }

  /**
   * Get the file open flags used
   *
   * Returns the numeric flags used with fs.openSync, which include:
   * - O_RDONLY: Always set for read-only access
   * - O_NONBLOCK: Set on Unix platforms for non-blocking reads
   */
  getOpenFlags(): number {
    return this.openFlags;
  }

  /**
   * Check if non-blocking mode is enabled
   *
   * Returns true if O_NONBLOCK flag was included when opening the file.
   * This will be true on Unix platforms and false on Windows.
   */
  isNonBlockingEnabled(): boolean {
    // Check if O_NONBLOCK is defined and was included in openFlags
    return constants.O_NONBLOCK !== undefined &&
      (this.openFlags & constants.O_NONBLOCK) === constants.O_NONBLOCK;
  }

  /**
   * Get the recommended file open flags for the current platform
   *
   * Static method to get the flags that would be used without starting a stream.
   * Useful for external code that needs to open files with compatible flags.
   *
   * @returns Numeric flags suitable for fs.openSync
   */
  static getRecommendedOpenFlags(): number {
    const isWindows = os.platform() === 'win32';
    let flags = constants.O_RDONLY;

    if (!isWindows && constants.O_NONBLOCK !== undefined) {
      flags = flags | constants.O_NONBLOCK;
    }

    return flags;
  }

  /**
   * Manually trigger a read (useful for testing or forcing immediate read)
   */
  triggerRead(): void {
    if (this.isActive) {
      this.readNewContent();
    }
  }

  /**
   * Start watching using fs.watch (event-based)
   *
   * fs.watch is more efficient as it uses OS-level file system events,
   * but can be less reliable on some platforms (especially network drives).
   */
  private startFsWatch(): void {
    if (!this.filePath) return;

    try {
      this.fsWatcher = watch(this.filePath, (eventType) => {
        // 'change' event indicates file was modified
        if (eventType === 'change' && this.isActive) {
          this.readNewContent();
        }
      });

      // Handle watcher errors
      this.fsWatcher.on('error', (error) => {
        this.emit('error', error);
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('error', err);
    }
  }

  /**
   * Start watching using fs.watchFile (polling-based)
   *
   * fs.watchFile is more reliable across platforms as it uses polling,
   * but has slightly higher CPU usage. Better for log files where reliability
   * is more important than efficiency.
   */
  private startFsWatchFile(): void {
    if (!this.filePath) return;

    // Listener for file changes
    const onFileChange = (curr: fs.Stats, prev: fs.Stats) => {
      // Check if file has grown
      if (curr.size > this.readPosition && this.isActive) {
        this.readNewContent();
      }
    };

    // Start watching with configured polling interval
    watchFile(this.filePath, { interval: this.options.pollInterval }, onFileChange);
  }

  /**
   * Read new content from the file since last read position
   *
   * Uses low-level fs operations with explicit position to read only
   * new bytes. Handles partial lines by buffering incomplete content.
   */
  private readNewContent(): void {
    if (!this.isActive || this.fd === null || !this.filePath) {
      return;
    }

    try {
      // Get current file size
      const stats = statSync(this.filePath);
      const newSize = stats.size;

      // No new content
      if (newSize <= this.readPosition) {
        this.emit('eof', this.readPosition);
        return;
      }

      const bytesToRead = newSize - this.readPosition;
      const buffer = Buffer.alloc(bytesToRead);

      // Read from current position
      // readSync with position parameter allows us to read from specific offset
      // without affecting the file descriptor's internal position
      const bytesRead = fs.readSync(this.fd, buffer, 0, bytesToRead, this.readPosition);

      if (bytesRead > 0) {
        // Update read position
        this.readPosition += bytesRead;

        // Decode as string
        const newContent = buffer.toString(this.options.encoding, 0, bytesRead);

        // Emit raw data event
        this.emit('data', newContent);

        // Process lines
        this.processLines(newContent);
      }
    } catch (error) {
      // Handle file read errors gracefully
      // Some errors are temporary and should not stop monitoring:
      // - EBUSY: File is temporarily busy (Windows)
      // - EAGAIN: Resource temporarily unavailable (non-blocking read, Unix)
      // - EWOULDBLOCK: Same as EAGAIN on most systems (non-blocking read)
      const errorMessage = error instanceof Error ? error.message : String(error);

      const isTemporaryError =
        errorMessage.includes('EBUSY') ||
        errorMessage.includes('EAGAIN') ||
        errorMessage.includes('EWOULDBLOCK');

      if (!isTemporaryError) {
        const err = error instanceof Error ? error : new Error(errorMessage);
        this.emit('error', err);
      }
      // For temporary errors (EBUSY/EAGAIN/EWOULDBLOCK), silently retry on next poll
      // This is expected behavior when using O_NONBLOCK flag
    }
  }

  /**
   * Process content into lines and emit line events
   *
   * Handles partial lines by buffering incomplete content at the end.
   * Supports both Unix (\n) and Windows (\r\n) line endings.
   */
  private processLines(content: string): void {
    // Combine with any buffered partial line from previous read
    const combined = this.lineBuffer + content;

    // Split on newlines (handles both \n and \r\n)
    const lines = combined.split(/\r?\n/);

    // Last element might be incomplete (no trailing newline)
    // Buffer it for the next read
    this.lineBuffer = lines.pop() || '';

    // Emit complete lines
    for (const line of lines) {
      this.emit('line', line);
    }
  }
}

/**
 * Create a new FileOutputStreamer instance
 *
 * Factory function for convenience.
 *
 * @returns A new FileOutputStreamer instance
 */
export function createFileOutputStreamer(): FileOutputStreamer {
  return new FileOutputStreamer();
}
