//go:build windows

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var getCompressedFileSizeW = kernel32.NewProc("GetCompressedFileSizeW")
var getVolumePathNameW = kernel32.NewProc("GetVolumePathNameW")
var getDiskFreeSpaceW = kernel32.NewProc("GetDiskFreeSpaceW")
var getVolumeInformationW = kernel32.NewProc("GetVolumeInformationW")
var getFileInformationByHandleEx = kernel32.NewProc("GetFileInformationByHandleEx")
var findFirstFileExW = kernel32.NewProc("FindFirstFileExW")
var findNextFileW = kernel32.NewProc("FindNextFileW")

const (
	fileListDirectory  = 0x0001
	fileReadAttributes = 0x0080
	fileShareAll       = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE | syscall.FILE_SHARE_DELETE

	fileStandardInfoClass             = 1
	fileIDBothDirectoryInfoClass      = 10
	fileFullDirectoryInfoClass        = 14
	fileFullDirectoryRestartInfoClass = 15
	directoryBufferSize               = 64 * 1024

	findExInfoBasic       = 1
	findFirstExLargeFetch = 2

	fileAttributeSparseFile         = 0x00000200
	fileAttributeOffline            = 0x00001000
	fileAttributeRecallOnOpen       = 0x00040000
	fileAttributeRecallOnDataAccess = 0x00400000
	fileSupportsHardLinks           = 0x00400000

	allocationSourceDirectory  = "win32-directory-allocation-size"
	allocationSourceStandard   = "win32-file-standard-info"
	allocationSourceCompressed = "win32-get-compressed-file-size"
	allocationSourceHardlink   = "hardlink-duplicate"
)

// win32FindData mirrors WIN32_FIND_DATAW. syscall.Win32finddata is one
// element short in both name arrays, so it cannot be passed to the W APIs.
type win32FindData struct {
	FileAttributes    uint32
	CreationTime      syscall.Filetime
	LastAccessTime    syscall.Filetime
	LastWriteTime     syscall.Filetime
	FileSizeHigh      uint32
	FileSizeLow       uint32
	Reserved0         uint32
	Reserved1         uint32
	FileName          [syscall.MAX_PATH]uint16
	AlternateFileName [14]uint16
}

func filetimeMilliseconds(value syscall.Filetime) int64 {
	return filetimeTicksMilliseconds(uint64(value.HighDateTime)<<32 | uint64(value.LowDateTime))
}

func filetimeTicksMilliseconds(ticks uint64) int64 {
	// FILETIME spans dates outside int64 Unix nanoseconds. Convert its 100 ns
	// ticks directly to milliseconds before applying the Windows epoch offset.
	return int64(ticks/10000) - 11644473600000
}

func callErrno(callErr error) error {
	if errno, ok := callErr.(syscall.Errno); ok && errno != 0 {
		return errno
	}
	return syscall.EINVAL
}

func findFirstFileEx(pattern string, data *win32FindData) (syscall.Handle, error) {
	pointer, err := syscall.UTF16PtrFromString(extendedLengthPath(pattern))
	if err != nil {
		return syscall.InvalidHandle, err
	}
	handle, _, callErr := findFirstFileExW.Call(
		uintptr(unsafe.Pointer(pointer)), findExInfoBasic, uintptr(unsafe.Pointer(data)), 0, 0, findFirstExLargeFetch,
	)
	if syscall.Handle(handle) == syscall.InvalidHandle {
		return syscall.InvalidHandle, callErrno(callErr)
	}
	return syscall.Handle(handle), nil
}

func findNextFile(handle syscall.Handle, data *win32FindData) error {
	ok, _, callErr := findNextFileW.Call(uintptr(handle), uintptr(unsafe.Pointer(data)))
	if ok == 0 {
		return callErrno(callErr)
	}
	return nil
}

func browseDirectory(ctx context.Context, root string, maxEntries int, showHidden *bool, compact bool) (map[string]interface{}, error) {
	if maxEntries <= 0 || maxEntries > 500000 {
		maxEntries = 500000
	}
	var data win32FindData
	handle, err := findFirstFileEx(filepath.Join(root, "*"), &data)
	if err != nil {
		if errno, ok := err.(syscall.Errno); ok && errno == syscall.ERROR_FILE_NOT_FOUND {
			columns := newBrowseColumns(0)
			return map[string]interface{}{"path": root, "entries": browseEntriesPayload([]browseEntry{}, columns, compact), "returned": 0, "total": 0, "hiddenFiltered": 0, "truncated": false}, nil
		}
		return nil, &os.PathError{Op: "FindFirstFile", Path: root, Err: err}
	}
	defer syscall.FindClose(handle)

	items := make([]browseEntry, 0, min(maxEntries, 10000))
	columns := newBrowseColumns(min(maxEntries, 10000))
	total := 0
	hiddenFiltered := 0
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		name := syscall.UTF16ToString(data.FileName[:])
		if name != "." && name != ".." {
			visible := showHidden == nil || *showHidden || (data.FileAttributes&syscall.FILE_ATTRIBUTE_HIDDEN == 0 && name[0] != '.')
			if visible {
				total++
				if total <= maxEntries {
					entry := browseEntry{
						Name:       name,
						Attributes: data.FileAttributes,
						Size:       uint64(data.FileSizeHigh)<<32 | uint64(data.FileSizeLow),
						Modified:   filetimeMilliseconds(data.LastWriteTime),
						Created:    filetimeMilliseconds(data.CreationTime),
						Accessed:   filetimeMilliseconds(data.LastAccessTime),
					}
					if compact {
						columns.append(entry)
					} else {
						items = append(items, entry)
					}
				}
			} else {
				hiddenFiltered++
			}
		}
		if err = findNextFile(handle, &data); err != nil {
			if err == syscall.ERROR_NO_MORE_FILES {
				break
			}
			return nil, &os.PathError{Op: "FindNextFile", Path: root, Err: err}
		}
	}
	return map[string]interface{}{
		"path": root, "entries": browseEntriesPayload(items, columns, compact), "returned": min(total, maxEntries), "total": total,
		"hiddenFiltered": hiddenFiltered, "truncated": total > maxEntries,
	}, nil
}

// directoryEntry is one record from a directory information class. It
// carries the allocation size, reparse tag and file ID straight from the
// directory, so tree scans never open individual files for them.
type directoryEntry struct {
	Name       string
	Attributes uint32
	ReparseTag uint32
	Logical    uint64
	Allocated  uint64
	FileID     uint64
	Modified   int64
}

func (entry *directoryEntry) directory() bool {
	return entry.Attributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0
}

// needsAllocationQuery reports whether the directory record's allocation
// cannot be trusted and the file must be asked directly. Filters such as
// WOF (CompactOS) hide their compressed stream and report zero allocation,
// and sparse files may be partially allocated. Offline and cloud placeholder
// files are never opened, so enumeration cannot trigger a recall; their
// directory allocation is what is stored locally.
func (entry *directoryEntry) needsAllocationQuery() bool {
	if entry.Attributes&(fileAttributeOffline|fileAttributeRecallOnOpen|fileAttributeRecallOnDataAccess) != 0 {
		return false
	}
	return entry.Attributes&fileAttributeSparseFile != 0 || (entry.Allocated == 0 && entry.Logical > 0)
}

// errStopDirectory ends a directory enumeration early without an error.
var errStopDirectory = errors.New("stop directory enumeration")

func unsupportedInformationClass(errno syscall.Errno) bool {
	switch errno {
	case 1, 50, 87, 120, 124: // INVALID_FUNCTION, NOT_SUPPORTED, INVALID_PARAMETER, CALL_NOT_IMPLEMENTED, INVALID_LEVEL
		return true
	}
	return false
}

func malformedDirectoryRecord(dir string) error {
	return &os.PathError{Op: "GetFileInformationByHandleEx", Path: dir, Err: fmt.Errorf("malformed directory record")}
}

type directoryReader struct {
	buffer []uint64 // 8-byte aligned record buffer
}

func newDirectoryReader() *directoryReader {
	return &directoryReader{buffer: make([]uint64, directoryBufferSize/8)}
}

// read enumerates dir through GetFileInformationByHandleEx and calls visit
// for every entry except "." and "..". Returning errStopDirectory from visit
// stops the enumeration and read returns nil.
func (reader *directoryReader) read(dir string, visit func(*directoryEntry) error) error {
	pointer, err := syscall.UTF16PtrFromString(extendedLengthPath(dir))
	if err != nil {
		return err
	}
	handle, err := syscall.CreateFile(pointer, fileListDirectory, fileShareAll, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return &os.PathError{Op: "CreateFile", Path: dir, Err: err}
	}
	defer syscall.CloseHandle(handle)
	buffer := unsafe.Slice((*byte)(unsafe.Pointer(&reader.buffer[0])), len(reader.buffer)*8)
	class := uint32(fileIDBothDirectoryInfoClass)
	first := true
	var entry directoryEntry
	for {
		ok, _, callErr := getFileInformationByHandleEx.Call(uintptr(handle), uintptr(class), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if ok == 0 {
			errno, _ := callErrno(callErr).(syscall.Errno)
			switch {
			case errno == syscall.ERROR_NO_MORE_FILES, first && errno == syscall.ERROR_FILE_NOT_FOUND:
				return nil
			case first && class == fileIDBothDirectoryInfoClass && unsupportedInformationClass(errno):
				// Filesystems without file IDs still support the class that
				// FindFirstFileEx uses, which also reports allocation sizes.
				class = fileFullDirectoryRestartInfoClass
				continue
			}
			return &os.PathError{Op: "GetFileInformationByHandleEx", Path: dir, Err: errno}
		}
		withFileID := class == fileIDBothDirectoryInfoClass
		if class == fileFullDirectoryRestartInfoClass {
			class = fileFullDirectoryInfoClass
		}
		first = false
		// FILE_ID_BOTH_DIR_INFO names start at 104 (after the 8-byte FileId);
		// FILE_FULL_DIR_INFO names start at 68.
		nameStart := 68
		if withFileID {
			nameStart = 104
		}
		for offset := 0; ; {
			if offset+nameStart > len(buffer) {
				return malformedDirectoryRecord(dir)
			}
			record := buffer[offset:]
			next := int(binary.LittleEndian.Uint32(record[0:]))
			nameLength := int(binary.LittleEndian.Uint32(record[60:]))
			if nameLength <= 0 || nameStart+nameLength > len(record) {
				return malformedDirectoryRecord(dir)
			}
			name := syscall.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(&record[nameStart])), nameLength/2))
			if name != "." && name != ".." {
				entry = directoryEntry{
					Name:       name,
					Modified:   filetimeTicksMilliseconds(binary.LittleEndian.Uint64(record[24:])),
					Logical:    binary.LittleEndian.Uint64(record[40:]),
					Allocated:  binary.LittleEndian.Uint64(record[48:]),
					Attributes: binary.LittleEndian.Uint32(record[56:]),
				}
				// For reparse points the EaSize field holds the reparse tag.
				if entry.Attributes&fileAttributeReparsePoint != 0 {
					entry.ReparseTag = binary.LittleEndian.Uint32(record[64:])
				}
				if withFileID {
					entry.FileID = binary.LittleEndian.Uint64(record[96:])
				}
				if err := visit(&entry); err != nil {
					if err == errStopDirectory {
						return nil
					}
					return err
				}
			}
			if next == 0 {
				break
			}
			offset += next
		}
	}
}

// treeWalker holds per-scan state shared by scan-tree and analyze-tree.
type treeWalker struct {
	reader  *directoryReader
	linked  *fileIDSet
	volume  volumeDetails
	hasInfo bool
}

func newTreeWalker(root string) *treeWalker {
	walker := &treeWalker{reader: newDirectoryReader()}
	volume, err := volumeGeometry(root)
	if err == nil {
		walker.volume = volume
		walker.hasInfo = true
	}
	walker.linked = newFileIDSet(err == nil && volume.Flags&fileSupportsHardLinks != 0, volume.FileSystem)
	return walker
}

// chargeFile returns the allocation to charge for a file entry and whether
// it still needs a per-file query. Repeat sightings of a hardlinked file
// are charged zero.
func (walker *treeWalker) chargeFile(entry *directoryEntry) (uint64, string, bool) {
	if !walker.linked.firstSighting(entry.FileID) {
		return 0, allocationSourceHardlink, false
	}
	if entry.needsAllocationQuery() {
		return entry.Allocated, allocationSourceDirectory, true
	}
	return entry.Allocated, allocationSourceDirectory, false
}

func (walker *treeWalker) volumeResult(root string) map[string]interface{} {
	if !walker.hasInfo {
		volume, err := volumeInfo(root)
		if err != nil {
			return map[string]interface{}{"clusterSize": 0, "allocationAccuracy": "unknown", "error": err.Error()}
		}
		return volume
	}
	return walker.volume.result()
}

func collectTreeEntries(ctx context.Context, root string, maxEntries int) (treeScanMetadata, error) {
	result := treeScanMetadata{
		Items:        make([]fileEntry, 0, min(maxEntries, 10000)),
		QueryIndexes: make([]int, 0, 64),
	}
	walker := newTreeWalker(root)
	stack := []string{root}
	for len(stack) > 0 && !result.Truncated {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		err := walker.reader.read(current, func(data *directoryEntry) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}
			if result.Scanned >= maxEntries {
				result.Truncated = true
				return errStopDirectory
			}
			itemPath := filepath.Join(current, data.Name)
			result.Scanned++
			if isNameSurrogateReparse(data.Attributes, data.ReparseTag) {
				result.Skipped++
			} else if data.directory() {
				result.Items = append(result.Items, fileEntry{Name: data.Name, Path: itemPath, Directory: true, Modified: data.Modified})
				result.Folders++
				stack = append(stack, itemPath)
			} else {
				allocated, source, query := walker.chargeFile(data)
				result.Items = append(result.Items, fileEntry{
					Name: data.Name, Path: itemPath, Logical: int64(data.Logical), Allocated: allocated,
					Modified: data.Modified, Allocation: source, Accuracy: "exact",
				})
				if query {
					result.QueryIndexes = append(result.QueryIndexes, len(result.Items)-1)
				} else {
					result.Allocated += allocated
				}
				result.Files++
				result.Logical += data.Logical
			}
			return nil
		})
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return result, ctxErr
			}
			// Only the root may fail the scan; an unreadable subfolder, or one
			// that fails mid-listing, is counted as skipped and keeps the
			// entries it already produced.
			if current == root {
				return result, err
			}
			result.Skipped++
		}
	}
	return result, nil
}

func analyzeTree(ctx context.Context, req request, out *writer) (map[string]interface{}, error) {
	started := time.Now()
	root := filepath.Clean(req.Path)
	rootInfo, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !rootInfo.IsDir() {
		return nil, &os.PathError{Op: "analyze-tree", Path: root, Err: fmt.Errorf("path is not a directory")}
	}
	acc := newAnalysisAccumulator(root, rootInfo.ModTime().UnixMilli())
	walker := newTreeWalker(root)
	type folderWork struct {
		Path  string
		Index int
	}
	queue := []folderWork{{Path: root, Index: 0}}
	for head := 0; head < len(queue) && !acc.Truncated; head++ {
		current := queue[head]
		readErr := walker.reader.read(current.Path, func(data *directoryEntry) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}
			if req.MaxEntries > 0 && acc.Scanned >= req.MaxEntries {
				acc.Truncated = true
				return errStopDirectory
			}
			itemPath := filepath.Join(current.Path, data.Name)
			acc.Scanned++
			if isNameSurrogateReparse(data.Attributes, data.ReparseTag) {
				acc.Skipped++
			} else if data.directory() {
				folderIndex := acc.addFolder(data.Name, itemPath, current.Index, data.Modified)
				queue = append(queue, folderWork{Path: itemPath, Index: folderIndex})
			} else {
				allocated, _, query := walker.chargeFile(data)
				if query {
					value, _, _, allocationErr := allocatedSize(itemPath, int64(data.Logical))
					if allocationErr != nil {
						value = data.Logical
						acc.Skipped++
					}
					allocated = value
				}
				acc.addFile(data.Name, itemPath, current.Index, data.Logical, allocated, data.Modified)
			}
			if acc.Scanned == 1 || acc.Scanned%10000 == 0 {
				out.send(response{Version: protocolVersion, ID: req.ID, Type: "progress", OK: true, Data: acc.progressResult(root, req.MaxEntries)})
			}
			return nil
		})
		if readErr != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, ctxErr
			}
			if current.Index == 0 {
				return nil, readErr
			}
			acc.Skipped++
		}
	}
	return acc.result(root, req.MaxEntries, walker.volumeResult(root), float64(time.Since(started).Microseconds())/1000), nil
}

// allocatedSize asks one file for the bytes it occupies on disk. The
// standard information class reports real allocation for every file,
// including resident, compressed, sparse and WOF-compressed files.
// GetCompressedFileSizeW is only a fallback: it returns the logical size for
// ordinary files.
func allocatedSize(itemPath string, logical int64) (uint64, string, string, error) {
	pointer, err := syscall.UTF16PtrFromString(extendedLengthPath(itemPath))
	if err != nil {
		return 0, allocationSourceStandard, "exact", err
	}
	handle, openErr := syscall.CreateFile(pointer, fileReadAttributes, fileShareAll, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if openErr == nil {
		// FILE_STANDARD_INFO: AllocationSize, EndOfFile, NumberOfLinks, DeletePending, Directory.
		var info [24]byte
		ok, _, _ := getFileInformationByHandleEx.Call(uintptr(handle), fileStandardInfoClass, uintptr(unsafe.Pointer(&info[0])), uintptr(len(info)))
		syscall.CloseHandle(handle)
		if ok != 0 {
			return binary.LittleEndian.Uint64(info[0:]), allocationSourceStandard, "exact", nil
		}
	}
	var high uint32
	low, _, callErr := getCompressedFileSizeW.Call(uintptr(unsafe.Pointer(pointer)), uintptr(unsafe.Pointer(&high)))
	if uint32(low) == 0xffffffff && callErr != syscall.Errno(0) {
		return 0, allocationSourceCompressed, "exact", callErr
	}
	return uint64(high)<<32 | uint64(uint32(low)), allocationSourceCompressed, "exact", nil
}

type volumeDetails struct {
	Root              string
	ClusterSize       uint64
	SectorsPerCluster uint32
	BytesPerSector    uint32
	FileSystem        string
	Flags             uint32
}

func volumeGeometry(itemPath string) (volumeDetails, error) {
	pointer, err := syscall.UTF16PtrFromString(extendedLengthPath(filepath.Clean(itemPath)))
	if err != nil {
		return volumeDetails{}, err
	}
	volumeBuffer := make([]uint16, 32768)
	ok, _, callErr := getVolumePathNameW.Call(
		uintptr(unsafe.Pointer(pointer)),
		uintptr(unsafe.Pointer(&volumeBuffer[0])),
		uintptr(len(volumeBuffer)),
	)
	if ok == 0 {
		return volumeDetails{}, callErrno(callErr)
	}
	var details volumeDetails
	var freeClusters uint32
	var totalClusters uint32
	ok, _, callErr = getDiskFreeSpaceW.Call(
		uintptr(unsafe.Pointer(&volumeBuffer[0])),
		uintptr(unsafe.Pointer(&details.SectorsPerCluster)),
		uintptr(unsafe.Pointer(&details.BytesPerSector)),
		uintptr(unsafe.Pointer(&freeClusters)),
		uintptr(unsafe.Pointer(&totalClusters)),
	)
	if ok == 0 {
		return volumeDetails{}, callErrno(callErr)
	}
	details.ClusterSize = uint64(details.SectorsPerCluster) * uint64(details.BytesPerSector)
	if details.ClusterSize == 0 {
		return volumeDetails{}, fmt.Errorf("volume reported a zero allocation unit")
	}
	fileSystem := make([]uint16, syscall.MAX_PATH+1)
	ok, _, _ = getVolumeInformationW.Call(
		uintptr(unsafe.Pointer(&volumeBuffer[0])), 0, 0, 0, 0,
		uintptr(unsafe.Pointer(&details.Flags)),
		uintptr(unsafe.Pointer(&fileSystem[0])), uintptr(len(fileSystem)),
	)
	if ok != 0 {
		details.FileSystem = syscall.UTF16ToString(fileSystem)
	}
	details.Root = stripExtendedLengthPrefix(syscall.UTF16ToString(volumeBuffer))
	return details, nil
}

func (details volumeDetails) result() map[string]interface{} {
	return map[string]interface{}{
		"root": details.Root, "clusterSize": details.ClusterSize,
		"sectorsPerCluster": details.SectorsPerCluster, "bytesPerSector": details.BytesPerSector,
		"fileSystem": details.FileSystem,
		// allocatedSource keeps its established value for existing consumers;
		// allocationMethod names how allocation is actually measured now.
		"allocatedSource": allocationSourceCompressed, "allocationMethod": allocationSourceDirectory,
		"allocationAccuracy": "exact",
	}
}

func volumeInfo(itemPath string) (map[string]interface{}, error) {
	details, err := volumeGeometry(itemPath)
	if err != nil {
		return nil, err
	}
	return details.result(), nil
}
