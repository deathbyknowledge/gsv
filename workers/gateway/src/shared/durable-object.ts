export function getDurableObjectByName<
  _Env,
  ObjectType extends Rpc.DurableObjectBranded,
>(
  namespace: DurableObjectNamespace<ObjectType>,
  name: string,
): DurableObjectStub<ObjectType> {
  return namespace.getByName(name);
}
