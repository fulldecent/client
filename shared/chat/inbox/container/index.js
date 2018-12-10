// @flow
import * as I from 'immutable'
import * as React from 'react'
import * as Constants from '../../../constants/chat2'
import * as Types from '../../../constants/types/chat2'
import * as Chat2Gen from '../../../actions/chat2-gen'
import * as RouteTreeGen from '../../../actions/route-tree-gen'
import * as Inbox from '..'
import {namedConnect} from '../../../util/container'
import type {Props as _Props, RowItem, RowItemSmall, RowItemBig} from '../index.types'
import normalRowData from './normal'
import filteredRowData from './filtered'
import ff from '../../../util/feature-flags'

type OwnProps = {|
  routeState: I.RecordOf<{
    smallTeamsExpanded: boolean,
  }>,
  navigateAppend: (...Array<any>) => any,
|}

const mapStateToProps = state => ({
  _metaMap: state.chat2.metaMap,
  _selectedConversationIDKey: Constants.getSelectedConversation(state),
  _smallTeamsExpanded: state.chat2.smallTeamsExpanded,
  _username: state.config.username,
  filter: state.chat2.inboxFilter,
  isLoading: Constants.anyChatWaitingKeys(state),
  neverLoaded: !state.chat2.inboxHasLoaded,
})

const mapDispatchToProps = (dispatch, {navigateAppend}) => ({
  _onSelect: (conversationIDKey: Types.ConversationIDKey) =>
    dispatch(Chat2Gen.createSelectConversation({conversationIDKey, reason: 'inboxFilterChanged'})),
  _onSelectNext: (rows, selectedConversationIDKey, direction) => {
    const goodRows: Array<RowItemSmall | RowItemBig> = rows.reduce((arr, row) => {
      if (row.type === 'small' || row.type === 'big') {
        arr.push(row)
      }
      return arr
    }, [])
    const idx = goodRows.findIndex(row => row.conversationIDKey === selectedConversationIDKey)
    if (goodRows.length) {
      const {conversationIDKey} = goodRows[(idx + direction + goodRows.length) % goodRows.length]
      dispatch(Chat2Gen.createSelectConversation({conversationIDKey, reason: 'inboxFilterArrow'}))
    }
  },
  _refreshInbox: () => dispatch(Chat2Gen.createInboxRefresh({reason: 'componentNeverLoaded'})),
  onNewChat: () =>
    dispatch(
      ff.newTeamBuildingForChat
        ? RouteTreeGen.createNavigateAppend({
            path: [{props: {}, selected: 'newChat'}],
          })
        : Chat2Gen.createSetPendingMode({pendingMode: 'searchingForUsers'})
    ),
  onUntrustedInboxVisible: (conversationIDKeys: Array<Types.ConversationIDKey>) =>
    dispatch(
      Chat2Gen.createMetaNeedsUpdating({
        conversationIDKeys,
        reason: 'untrusted inbox visible',
      })
    ),
  toggleSmallTeamsExpanded: () => dispatch(Chat2Gen.createToggleSmallTeamsExpanded()),
})

// This merge props is not spreading on purpose so we never have any random props that might mutate and force a re-render
const mergeProps = (stateProps, dispatchProps, ownProps) => {
  const {allowShowFloatingButton, rows, smallTeamsExpanded} = stateProps.filter
    ? filteredRowData(stateProps._metaMap, stateProps.filter, stateProps._username)
    : normalRowData(stateProps._metaMap, stateProps._smallTeamsExpanded)
  return {
    _isLoading: stateProps.isLoading,
    _refreshInbox: dispatchProps._refreshInbox,
    allowShowFloatingButton,
    filter: stateProps.filter,
    neverLoaded: stateProps.neverLoaded,
    onNewChat: dispatchProps.onNewChat,
    onSelectDown: () => dispatchProps._onSelectNext(rows, stateProps._selectedConversationIDKey, 1),
    onSelectUp: () => dispatchProps._onSelectNext(rows, stateProps._selectedConversationIDKey, -1),
    onUntrustedInboxVisible: dispatchProps.onUntrustedInboxVisible,
    rows,
    smallTeamsExpanded,
    toggleSmallTeamsExpanded: dispatchProps.toggleSmallTeamsExpanded,
  }
}

type Props = $Diff<
  {|
    ..._Props,
    _refreshInbox: () => void,
    _isLoading: boolean,
  |},
  {
    filterFocusCount: number,
    focusFilter: () => void,
  }
>

type State = {
  filterFocusCount: number,
}
class InboxWrapper extends React.PureComponent<Props, State> {
  state = {
    filterFocusCount: 0,
  }
  _focusFilter = () => {
    this.setState(p => ({filterFocusCount: p.filterFocusCount + 1}))
  }

  _onSelectUp = () => this.props.onSelectUp()
  _onSelectDown = () => this.props.onSelectDown()

  componentDidMount() {
    if (this.props.neverLoaded && !this.props._isLoading) {
      this.props._refreshInbox()
    }
  }

  _isExpanded(rows: Array<RowItem>) {
    return rows.length > 5 && rows[5].type === 'small'
  }

  componentDidUpdate(prevProps) {
    const loadedForTheFirstTime = prevProps.rows.length === 0 && this.props.rows.length > 0
    // See if the first 6 are small, this implies it's expanded
    const wasExpanded = this._isExpanded(prevProps.rows)
    const isExpanded = this._isExpanded(this.props.rows)
    if (loadedForTheFirstTime || (isExpanded && !wasExpanded)) {
      const toUnbox = this.props.rows.slice(0, 20).reduce((arr, row) => {
        if (row.type === 'small' || row.type === 'big') {
          arr.push(row.conversationIDKey)
        }
        return arr
      }, [])
      if (toUnbox.length) {
        this.props.onUntrustedInboxVisible(toUnbox)
      }
    }
  }

  render() {
    const Component = Inbox.default
    const {_refreshInbox, _isLoading, ...rest} = this.props
    return (
      <Component
        {...rest}
        filterFocusCount={this.state.filterFocusCount}
        focusFilter={this._focusFilter}
        onSelectUp={this._onSelectUp}
        onSelectDown={this._onSelectDown}
      />
    )
  }
}

export default namedConnect<OwnProps, _, _, _, _>(mapStateToProps, mapDispatchToProps, mergeProps, 'Inbox')(
  InboxWrapper
)
