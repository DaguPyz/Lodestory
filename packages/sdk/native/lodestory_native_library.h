#ifndef LODESTORY_NATIVE_LIBRARY_H
#define LODESTORY_NATIVE_LIBRARY_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ABI v1. 所有入口均在同一个后台线程调用，不能跨边界抛异常或展开 panic。
 * 库的加载/卸载初始化程序不得启动后台任务；实例资源必须由 init/shutdown 管理。 */
typedef struct LodestoryLibraryBuffer {
    uint8_t *data;
    size_t len;
} LodestoryLibraryBuffer;

uint32_t lodestory_library_abi_version(void); /* 返回 1 */

/* 成功时返回 0 并写入非空实例。失败时若写入非空实例，宿主将尝试 shutdown；
 * 若返回空实例，库必须已清理所有部分初始化产生的资源和后台任务。 */
int32_t lodestory_library_init(void **instance);

/* request 是 UTF-8 JSON，仅在调用期间有效。成功返回 0，response 是 UTF-8 JSON；
 * 非零表示调用设施失败，response 可以包含 UTF-8 错误说明。输出由库分配并释放。 */
int32_t lodestory_library_call(void *instance, const uint8_t *request, size_t request_len,
                               LodestoryLibraryBuffer *response);

/* 成功返回 0，结束所有库内后台任务、释放实例，之后不得使用实例。
 * 失败返回非零，实例仍须可用于重试 shutdown，且不得释放正在使用的资源。 */
int32_t lodestory_library_shutdown(void *instance);

/* 所有非空输出必须能使用同一 data 和 len 调用此函数一次。 */
void lodestory_library_free_buffer(uint8_t *data, size_t len);

#ifdef __cplusplus
}
#endif
#endif
