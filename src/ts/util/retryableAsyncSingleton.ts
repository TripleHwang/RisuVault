export function createRetryableAsyncSingleton<T>(loader: () => Promise<T>): () => Promise<T> {
    let value: T | undefined
    let pending: Promise<T> | undefined

    return async () => {
        if(value !== undefined) return value
        if(!pending){
            pending = loader()
                .then((loaded) => {
                    value = loaded
                    return loaded
                })
                .catch((error) => {
                    pending = undefined
                    throw error
                })
        }
        return await pending
    }
}
