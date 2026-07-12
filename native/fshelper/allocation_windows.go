//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var getCompressedFileSizeW = kernel32.NewProc("GetCompressedFileSizeW")
var getVolumePathNameW = kernel32.NewProc("GetVolumePathNameW")
var getDiskFreeSpaceW = kernel32.NewProc("GetDiskFreeSpaceW")

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
