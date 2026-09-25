package main

import "strings"

const (
	fileAttributeReparsePoint = 0x00000400
	// Name-surrogate reparse tags (symlinks, junctions, mount points) name
	// another location. Every other tag (cloud placeholders, WOF/CompactOS,
	// deduplication, ...) belongs to a real file or directory stored here.
	reparseTagNameSurrogate = 0x20000000
)

// isNameSurrogateReparse reports whether an entry is a link to another
// namespace location that tree scans must not follow or charge.
func isNameSurrogateReparse(attributes uint32, reparseTag uint32) bool {
	return attributes&fileAttributeReparsePoint != 0 && reparseTag&reparseTagNameSurrogate != 0
}

// extendedLengthPath adds the Win32 extended-length prefix to a cleaned
// absolute path so raw API calls are not limited to MAX_PATH. Relative,
// device and already-prefixed paths are returned unchanged.
func extendedLengthPath(itemPath string) string {
	if strings.HasPrefix(itemPath, `\\?\`) || strings.HasPrefix(itemPath, `\\.\`) {
		return itemPath
	}
	if strings.HasPrefix(itemPath, `\\`) {
		return `\\?\UNC\` + itemPath[2:]
	}
	if len(itemPath) >= 3 && itemPath[1] == ':' && itemPath[2] == '\\' {
		letter := itemPath[0] | 0x20
		if letter >= 'a' && letter <= 'z' {
			return `\\?\` + itemPath
		}
	}
	return itemPath
}

// stripExtendedLengthPrefix converts an extended-length path back to the
// ordinary form used on the wire.
func stripExtendedLengthPrefix(itemPath string) string {
	if strings.HasPrefix(itemPath, `\\?\UNC\`) {
		return `\\` + itemPath[len(`\\?\UNC\`):]
	}
	if strings.HasPrefix(itemPath, `\\?\`) && len(itemPath) >= 6 && itemPath[5] == ':' {
		return itemPath[len(`\\?\`):]
	}
	return itemPath
}

// Dense bitmaps cover NTFS MFT record numbers up to this bound (32 MiB of
// bits); anything larger falls back to the map.
const fileIDDenseLimit = 1 << 28

// fileIDSet charges hardlinked files once. A scan never follows name
// surrogates (mount points included), so every entry lives on the root's
// volume and the file ID alone identifies the file. On NTFS the low 48 bits
// of a file ID are the dense MFT record number, so a bitmap is far smaller
// than a map; other filesystems use a map.
type fileIDSet struct {
	enabled bool
	dense   bool
	bits    []uint64
	ids     map[uint64]struct{}
}

func newFileIDSet(supportsHardLinks bool, fileSystem string) *fileIDSet {
	return &fileIDSet{enabled: supportsHardLinks, dense: strings.EqualFold(fileSystem, "NTFS")}
}

// firstSighting records id and reports whether it had not been seen before.
// Zero IDs (filesystems without stable IDs) are never deduplicated.
func (set *fileIDSet) firstSighting(id uint64) bool {
	if set == nil || !set.enabled || id == 0 {
		return true
	}
	if set.dense {
		if index := id & 0x0000ffffffffffff; index < fileIDDenseLimit {
			word := int(index >> 6)
			if word >= len(set.bits) {
				grown := make([]uint64, max(word+1, len(set.bits)*2))
				copy(grown, set.bits)
				set.bits = grown
			}
			mask := uint64(1) << (index & 63)
			if set.bits[word]&mask != 0 {
				return false
			}
			set.bits[word] |= mask
			return true
		}
	}
	if set.ids == nil {
		set.ids = make(map[uint64]struct{})
	}
	if _, seen := set.ids[id]; seen {
		return false
	}
	set.ids[id] = struct{}{}
	return true
}
