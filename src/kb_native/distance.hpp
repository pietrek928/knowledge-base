#pragma once
#include <string>
#include <vector>

namespace kb {

double damerau_levenshtein(const std::string &a, const std::string &b);
double normalized_similarity(const std::string &a, const std::string &b);

struct FuzzyHit {
  int start;
  int end;
  double score;
};

std::vector<FuzzyHit> fuzzy_window_search(const std::string &text, const std::string &pattern,
                                          double min_score, int max_hits,
                                          const std::vector<int> &candidate_starts);

} // namespace kb
