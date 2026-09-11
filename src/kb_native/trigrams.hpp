#pragma once
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace kb {

using TrigramMap = std::unordered_map<uint32_t, std::vector<int>>;

inline uint32_t pack_trigram(char a, char b, char c) {
  return (static_cast<uint32_t>(static_cast<unsigned char>(a)) << 16) |
         (static_cast<uint32_t>(static_cast<unsigned char>(b)) << 8) |
         static_cast<uint32_t>(static_cast<unsigned char>(c));
}

TrigramMap build_trigrams(const std::string &text);
std::vector<int> trigram_candidates(const TrigramMap &index, const std::string &pattern,
                                    int max_candidates = 200);

} // namespace kb
