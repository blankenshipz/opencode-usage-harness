// On-demand guidance only. Keep task intent, scope, ownership and execution in
// their existing tools; retrieving a template never creates an assignment.
export function integrationAssignmentTemplate() {
  return {
    kind:'integration',
    promptTemplate:[
      'Contract: <producer -> consumer; agreed representation and schema/version; exact input artifact/revision pins or explicitly unresolved contract decision>.',
      'Implement: <one end-to-end slice; producer/consumer changes plus necessary serializers, schemas and tests>.',
      'Verify: <one executable integration command; expected observable assertions; existing live/local/synthetic verification mode and receipt location>.',
      'Handoff: <next existing owner and its parent/session IDs; exact output artifact/revision and receipt; remaining dependency, or none>.',
      'Continue through meaningful integration and targeted verification. Freeze at an integration/acceptance boundary; reuse unchanged pins and passing evidence rather than freezing and handing off each small edit.',
    ].join('\n'),
    fields:{
      task_intent:'Keep the agreed contract/reference in current intent assumptions or check descriptions; revise through the root owner if requirements change.',
      'task_dispatch.prompt':'Fill the compact prompt above; explicitly resolve an unknown producer/consumer contract before divergent implementations.',
      'task_dispatch.checkIds':'Use current assigned acceptance-check IDs and required verification modes; a local pass does not satisfy a real-service check.',
      'task_dispatch.writePaths':'List authorized workspace-relative implementation, serializer, schema and test paths needed by this slice. Discover them before assignment; scope expansion still uses normal admission and ownership checks.',
      'task_dispatch.taskId/workKey/sessionID':'Retain existing ownership identity for continuation. Naming the next owner in a handoff does not dispatch or adopt it; coordinate through its recorded parent.',
    },
    authority:'Guidance only. No new gate, permission, write scope, model/provider choice, review waiver, automatic dispatch or verification result. Use existing intent, admission, collection and review tools.',
  };
}
