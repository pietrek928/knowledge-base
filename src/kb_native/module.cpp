#include <nanobind/nanobind.h>
#include <nanobind/ndarray.h>
#include <nanobind/stl/pair.h>
#include <nanobind/stl/string.h>
#include <nanobind/stl/tuple.h>
#include <nanobind/stl/vector.h>

#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

#include "aho_corasick.hpp"
#include "bm25.hpp"
#include "distance.hpp"
#include "suffix_array.hpp"
#include "trigrams.hpp"
#include "vectors.hpp"

namespace nb = nanobind;

namespace {

bool ndarray_writeable(nb::handle h) {
  return nb::cast<bool>(h.attr("flags").attr("writeable"));
}

template <typename T> struct BorrowOrCopy {
  std::vector<std::remove_const_t<T>> owned;
  const std::remove_const_t<T> *ptr = nullptr;
};

template <typename T, typename... Args>
BorrowOrCopy<T> prepare_buf(nb::ndarray<T, Args...> arr, size_t nelem) {
  using U = std::remove_const_t<T>;
  BorrowOrCopy<T> b;
  // const-annotated ndarray accepts both RO and RW; only borrow when RO.
  nb::object py = arr.cast();
  if (!ndarray_writeable(py) && arr.data() != nullptr) {
    b.ptr = reinterpret_cast<const U *>(arr.data());
    return b;
  }
  b.owned.resize(nelem);
  if (nelem && arr.data() != nullptr) {
    std::memcpy(b.owned.data(), arr.data(), sizeof(U) * nelem);
  }
  b.ptr = b.owned.data();
  return b;
}

} // namespace

NB_MODULE(kb_native, m) {
  m.doc() = "Knowledge-base native algorithms";

  // Strings: take by value (one materialization), compute under released GIL.
  m.def("build_suffix_array", [](std::string text) {
    std::vector<int> out;
    {
      nb::gil_scoped_release release;
      out = kb::build_suffix_array(text);
    }
    return out;
  });

  m.def("build_lcp", [](std::string text, std::vector<int> sa) {
    std::vector<int> out;
    {
      nb::gil_scoped_release release;
      out = kb::build_lcp(text, sa);
    }
    return out;
  });

  m.def(
      "sa_find",
      [](std::string text, std::vector<int> sa, std::string pattern, int max_hits) {
        std::vector<kb::Match> hits;
        {
          nb::gil_scoped_release release;
          hits = kb::sa_find(text, sa, pattern, max_hits);
        }
        std::vector<std::tuple<int, int, float>> out;
        out.reserve(hits.size());
        for (auto &h : hits)
          out.emplace_back(h.start, h.end, h.score);
        return out;
      },
      nb::arg("text"), nb::arg("sa"), nb::arg("pattern"), nb::arg("max_hits") = 1000);

  m.def("build_trigrams", [](std::string text) {
    kb::TrigramMap map;
    {
      nb::gil_scoped_release release;
      map = kb::build_trigrams(text);
    }
    std::vector<std::pair<uint32_t, std::vector<int>>> out;
    out.reserve(map.size());
    for (auto &[k, v] : map)
      out.emplace_back(k, std::move(v));
    return out;
  });

  m.def(
      "trigram_candidates",
      [](const std::vector<std::pair<uint32_t, std::vector<int>>> &entries, std::string pattern,
         int max_candidates) {
        kb::TrigramMap map;
        for (auto &[k, v] : entries)
          map[k] = v;
        std::vector<int> out;
        {
          nb::gil_scoped_release release;
          out = kb::trigram_candidates(map, pattern, max_candidates);
        }
        return out;
      },
      nb::arg("entries"), nb::arg("pattern"), nb::arg("max_candidates") = 200);

  nb::class_<kb::AhoCorasick>(m, "AhoCorasick")
      .def(nb::init<>())
      .def("build", &kb::AhoCorasick::build)
      .def("search", [](const kb::AhoCorasick &self, std::string text) {
        std::vector<kb::ACHit> hits;
        {
          nb::gil_scoped_release release;
          hits = self.search(text);
        }
        std::vector<std::tuple<int, int, int>> out;
        out.reserve(hits.size());
        for (auto &h : hits)
          out.emplace_back(h.pattern_id, h.start, h.end);
        return out;
      });

  m.def("damerau_levenshtein", &kb::damerau_levenshtein);
  m.def("normalized_similarity", &kb::normalized_similarity);
  m.def(
      "fuzzy_window_search",
      [](std::string text, std::string pattern, double min_score, int max_hits,
         std::vector<int> candidates) {
        std::vector<kb::FuzzyHit> hits;
        {
          nb::gil_scoped_release release;
          hits = kb::fuzzy_window_search(text, pattern, min_score, max_hits, candidates);
        }
        std::vector<std::tuple<int, int, double>> out;
        for (auto &h : hits)
          out.emplace_back(h.start, h.end, h.score);
        return out;
      },
      nb::arg("text"), nb::arg("pattern"), nb::arg("min_score") = 0.7, nb::arg("max_hits") = 50,
      nb::arg("candidates") = std::vector<int>{});

  m.def(
      "bm25_score",
      [](const std::vector<int> &tfs, const std::vector<float> &idfs, int doc_len, float avgdl,
         float k1, float b) { return kb::bm25_score(tfs, idfs, doc_len, avgdl, {k1, b}); },
      nb::arg("tfs"), nb::arg("idfs"), nb::arg("doc_len"), nb::arg("avgdl"), nb::arg("k1") = 0.9f,
      nb::arg("b") = 0.75f);

  m.def(
      "bm25_batch",
      [](const std::vector<std::vector<int>> &tfs, const std::vector<float> &idfs,
         const std::vector<int> &doc_lens, float avgdl, float k1,
         float b) { return kb::bm25_batch(tfs, idfs, doc_lens, avgdl, {k1, b}); },
      nb::arg("tfs"), nb::arg("idfs"), nb::arg("doc_lens"), nb::arg("avgdl"), nb::arg("k1") = 0.9f,
      nb::arg("b") = 0.75f);

  m.def("cosine_f32", [](nb::ndarray<const float, nb::ndim<1>, nb::c_contig> a,
                         nb::ndarray<const float, nb::ndim<1>, nb::c_contig> b) {
    if (a.shape(0) != b.shape(0))
      throw std::invalid_argument("dim mismatch");
    return kb::cosine_f32(a.data(), b.data(), static_cast<int>(a.shape(0)));
  });

  m.def("pack_binary", [](nb::ndarray<const float, nb::ndim<1>, nb::c_contig> vec) {
    int dim = static_cast<int>(vec.shape(0));
    int nwords = (dim + 63) / 64;
    auto buf = prepare_buf(vec, static_cast<size_t>(dim));
    std::vector<uint64_t> out(static_cast<size_t>(nwords));
    {
      nb::gil_scoped_release release;
      kb::pack_binary(buf.ptr, dim, out.data());
    }
    return out;
  });

  m.def("hamming_distance", [](const std::vector<uint64_t> &a, const std::vector<uint64_t> &b) {
    if (a.size() != b.size())
      throw std::invalid_argument("nwords mismatch");
    return kb::hamming_distance(a.data(), b.data(), static_cast<int>(a.size()));
  });

  m.def(
      "hamming_topk",
      [](nb::ndarray<const uint64_t, nb::ndim<2>, nb::c_contig> matrix,
         nb::ndarray<const uint64_t, nb::ndim<1>, nb::c_contig> query, int k) {
        int nrows = static_cast<int>(matrix.shape(0));
        int nwords = static_cast<int>(matrix.shape(1));
        if (static_cast<int>(query.shape(0)) != nwords)
          throw std::invalid_argument("query nwords mismatch");
        auto mat = prepare_buf(matrix, static_cast<size_t>(nrows) * static_cast<size_t>(nwords));
        auto q = prepare_buf(query, static_cast<size_t>(nwords));
        std::vector<std::pair<int, int>> out;
        {
          nb::gil_scoped_release release;
          out = kb::hamming_topk(mat.ptr, nrows, nwords, q.ptr, k);
        }
        return out;
      },
      nb::arg("matrix"), nb::arg("query"), nb::arg("k"));

  m.def(
      "rescore_int8",
      [](nb::ndarray<const float, nb::ndim<1>, nb::c_contig> query,
         nb::ndarray<const int8_t, nb::ndim<2>, nb::c_contig> rows,
         nb::ndarray<const float, nb::ndim<1>, nb::c_contig> scales, std::vector<int> row_ids) {
        int dim = static_cast<int>(query.shape(0));
        int nrows = static_cast<int>(rows.shape(0));
        if (static_cast<int>(rows.shape(1)) != dim)
          throw std::invalid_argument("dim mismatch");
        auto q = prepare_buf(query, static_cast<size_t>(dim));
        auto r = prepare_buf(rows, static_cast<size_t>(nrows) * static_cast<size_t>(dim));
        auto s = prepare_buf(scales, static_cast<size_t>(nrows));
        std::vector<float> out;
        {
          nb::gil_scoped_release release;
          out = kb::rescore_int8(q.ptr, dim, r.ptr, nrows, s.ptr, row_ids);
        }
        return out;
      },
      nb::arg("query"), nb::arg("rows"), nb::arg("scales"), nb::arg("row_ids"));

  m.def(
      "rescore_f16",
      [](nb::ndarray<const float, nb::ndim<1>, nb::c_contig> query,
         nb::ndarray<const uint16_t, nb::ndim<2>, nb::c_contig> rows, std::vector<int> row_ids) {
        int dim = static_cast<int>(query.shape(0));
        int nrows = static_cast<int>(rows.shape(0));
        if (static_cast<int>(rows.shape(1)) != dim)
          throw std::invalid_argument("dim mismatch");
        auto q = prepare_buf(query, static_cast<size_t>(dim));
        auto r = prepare_buf(rows, static_cast<size_t>(nrows) * static_cast<size_t>(dim));
        std::vector<float> out;
        {
          nb::gil_scoped_release release;
          out = kb::rescore_f16(q.ptr, dim, r.ptr, nrows, row_ids);
        }
        return out;
      },
      nb::arg("query"), nb::arg("rows"), nb::arg("row_ids"));

  m.def("coverage", [](const std::string &text, const std::string &pattern) {
    if (pattern.empty())
      return 0.0;
    if (text.find(pattern) != std::string::npos)
      return 1.0;
    return kb::normalized_similarity(text, pattern);
  });
}
