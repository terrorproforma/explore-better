//go:build !windows

package main

func allocatedSize(_ string, logical int64) (uint64, string, string, error) {
	if logical < 0 {
		logical = 0
	}
	return uint64(logical), "logical-size-fallback", "estimated", nil
}

func volumeInfo(itemPath string) (map[string]interface{}, error) {
	return map[string]interface{}{"root": itemPath, "clusterSize": 0, "allocatedSource": "logical-size-fallback", "allocationAccuracy": "estimated"}, nil
}
