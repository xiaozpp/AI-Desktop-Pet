def make_generation_send(send_func, generation, is_current):
    async def guarded_send(type_str, payload):
        if is_current(generation):
            await send_func(type_str, payload)
    return guarded_send
