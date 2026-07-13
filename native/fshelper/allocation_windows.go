//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var getCompressedFileSizeW = kernel32.NewProc("GetCompressedFileSizeW")
var getVolumePathNameW = kernel32.NewProc("GetVolumePathNameW")
var getDiskFreeSpaceW = kernel32.NewProc("GetDiskFreeSpaceW")

func filetimeMilliseconds(value syscall.Filetime) int64 {
	return value.Nanoseconds() / 1_000_000
}

func browseDirectory(ctx context.Context, root string, maxEntries int, showHidden *bool, compact bool) (map[string]interface{}, error) {
	if maxEntries <= 0 || maxEntries > 500000 {
		maxEntries = 500000
	}
	pattern, err := syscall.UTF16PtrFromString(filepath.Join(root, "*"))
	if err != nil {
		return nil, err
	}
	var data syscall.Win32finddata
	handle, err := syscall.FindFirstFile(pattern, &data)
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
		if err = syscall.FindNextFile(handle, &data); err != nil {
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

func collectTreeEntries(ctx context.Context, root string, maxEntries int) (treeScanMetadata, error) {
	result := treeScanMetadata{
		Items:       make([]fileEntry, 0, min(maxEntries, 10000)),
		FileIndexes: make([]int, 0, min(maxEntries, 10000)),
	}
	stack := []string{root}
	for len(stack) > 0 && !result.Truncated {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		pattern, err := syscall.UTF16PtrFromString(filepath.Join(current, "*"))
		if err != nil {
			return result, err
		}
		var data syscall.Win32finddata
		handle, err := syscall.FindFirstFile(pattern, &data)
		if err != nil {
			if errno, ok := err.(syscall.Errno); ok && errno == syscall.ERROR_FILE_NOT_FOUND {
				continue
			}
			if current == root {
				return result, &os.PathError{Op: "FindFirstFile", Path: current, Err: err}
			}
			result.Skipped++
			continue
		}
		stop := false
		for {
			select {
			case <-ctx.Done():
				syscall.FindClose(handle)
				return result, ctx.Err()
			default:
			}
			name := syscall.UTF16ToString(data.FileName[:])
			if name != "." && name != ".." {
				if result.Scanned >= maxEntries {
					result.Truncated = true
					stop = true
				} else {
					itemPath := filepath.Join(current, name)
					result.Scanned++
					if data.FileAttributes&0x00000400 != 0 {
						result.Skipped++
					} else if data.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0 {
						result.Items = append(result.Items, fileEntry{Name: name, Path: itemPath, Directory: true, Modified: filetimeMilliseconds(data.LastWriteTime)})
						result.Folders++
						stack = append(stack, itemPath)
					} else {
						logical := uint64(data.FileSizeHigh)<<32 | uint64(data.FileSizeLow)
						result.Items = append(result.Items, fileEntry{Name: name, Path: itemPath, Logical: int64(logical), Modified: filetimeMilliseconds(data.LastWriteTime)})
						result.FileIndexes = append(result.FileIndexes, len(result.Items)-1)
						result.Files++
						result.Logical += logical
					}
				}
			}
			if stop {
				break
			}
			if err = syscall.FindNextFile(handle, &data); err != nil {
				if err == syscall.ERROR_NO_MORE_FILES {
					break
				}
				syscall.FindClose(handle)
				return result, &os.PathError{Op: "FindNextFile", Path: current, Err: err}
			}
		}
		syscall.FindClose(handle)
	}
	return result, nil
}

func allocatedSize(itemPath string, logical int64) (uint64, string, string, error) {
	pointer, err := syscall.UTF16PtrFromString(itemPath)
	if err != nil {
		return 0, "win32-get-compressed-file-size", "exact", err
	}
	var high uint32
	low, _, callErr := getCompressedFileSizeW.Call(uintptr(unsafe.Pointer(pointer)), uintptr(unsafe.Pointer(&high)))
	if uint32(low) == 0xffffffff && callErr != syscall.Errno(0) {
		return 0, "win32-get-compressed-file-size", "exact", callErr
	}
	return uint64(high)<<32 | uint64(uint32(low)), "win32-get-compressed-file-size", "exact", nil
}

func volumeInfo(itemPath string) (map[string]interface{}, error) {
	pointer, err := syscall.UTF16PtrFromString(itemPath)
	if err != nil {
		return nil, err
	}
	volumeBuffer := make([]uint16, 32768)
	ok, _, callErr := getVolumePathNameW.Call(
		uintptr(unsafe.Pointer(pointer)),
		uintptr(unsafe.Pointer(&volumeBuffer[0])),
		uintptr(len(volumeBuffer)),
	)
	if ok == 0 {
		return nil, callErr
	}
	var sectorsPerCluster uint32
	var bytesPerSector uint32
	var freeClusters uint32
	var totalClusters uint32
	ok, _, callErr = getDiskFreeSpaceW.Call(
		uintptr(unsafe.Pointer(&volumeBuffer[0])),
		uintptr(unsafe.Pointer(&sectorsPerCluster)),
		uintptr(unsafe.Pointer(&bytesPerSector)),
		uintptr(unsafe.Pointer(&freeClusters)),
		uintptr(unsafe.Pointer(&totalClusters)),
	)
	if ok == 0 {
		return nil, callErr
	}
	clusterSize := uint64(sectorsPerCluster) * uint64(bytesPerSector)
	if clusterSize == 0 {
		return nil, fmt.Errorf("volume reported a zero allocation unit")
	}
	return map[string]interface{}{
		"root": syscall.UTF16ToString(volumeBuffer), "clusterSize": clusterSize,
		"sectorsPerCluster": sectorsPerCluster, "bytesPerSector": bytesPerSector,
		"allocatedSource": "win32-get-compressed-file-size", "allocationAccuracy": "exact",
	}, nil
}
